/**
 * Cable curve (structure restyle stage 4, 0d "cable sockets", slice 3).
 *
 * A cable runs socket to socket as one cubic Bezier: from socket A out along
 * A's outward normal, bending round to come into socket B along B's normal
 * (the owner-approved concept page). Control points sit `k` along each normal,
 * `k = min(CABLE_TAIL_MAX, d * CABLE_TAIL_FRACTION)` for socket distance `d`;
 * a connector end (small, round, takes a cable from any side) uses a short
 * tail `min(CABLE_SHORT_TAIL, k)`. Each end first runs straight out along
 * its normal for a stub (`min(CABLE_SOCKET_STUB, tail / 2)`): the polyline's
 * first and last segments lie exactly on the socket normals, so the cable
 * meets the socket flush (owner 2026-11-21). The curve proper runs stub end
 * to stub end, its controls still `tail` out from the sockets (G1 at the
 * stubs).
 *
 * `flattenCableCurve` turns the curve into a fixed `CABLE_CURVE_SEGMENTS`
 * polyline in a caller-owned Float64Array plus its box, allocation-free (the
 * build preview runs this every frame on a phone). `isCablePolylineBlocked`
 * is the polyline form of `isConnectionLineBlocked` (Grid.ts): same nodes,
 * landing pads (`gridNodePadBox`, solid to cables) and obstacles count, the
 * two endpoints' bodies are ignored (their pads are not), and it reuses the same
 * segment tests, with the polyline's box as a broad phase. It lives here, not
 * in Grid.ts, to keep Grid.ts under the god-file ceiling.
 *
 * `pickCableSocketPair` (slice 4) is the socket half of `canConnect`: it picks the
 * pair a cable runs between. It lives here for the same reason.
 */
import {
  segmentHitsObstacle, segmentIntersectsAabb, type CanConnectReason, type GridNode, type GridObstacle,
} from './Grid.js';
import { structureSockets, structureSocketToWorld } from '../../shared-types/structureKinds.js';
import { CABLE_NO_SOCKET, type Connection } from './Connection.js';
import { structureLinksBoundBySockets } from '../leveling/structureLevel.js';
import { MIN_CABLE_LENGTH } from './structureGridConstants.js';
import { keepClearBox } from './placementRules.js';

/** Facing-test tolerance (world units of dot product): a socket at right
 *  angles to its partner counts as facing it, whatever the float noise. */
const FACE_EPS = 1e-6;

/** Segments in a flattened cable curve (points = segments + 1). */
export const CABLE_CURVE_SEGMENTS = 12;
/** Float64Array length a flattened curve needs: (x, y) per point. */
export const CABLE_CURVE_FLOATS = (CABLE_CURVE_SEGMENTS + 1) * 2;
/** Longest control-point tail along a socket normal (world units). */
export const CABLE_TAIL_MAX = 260;
/** Tail as a share of the socket-to-socket distance. */
export const CABLE_TAIL_FRACTION = 0.35;
/** A connector end's short tail cap (world units). */
export const CABLE_SHORT_TAIL = 40;
/** Longest straight stub a cable runs out of a socket along its normal
 *  before it bends (world units; at most half the tail). */
export const CABLE_SOCKET_STUB = 24;

/** A world-space socket: point plus unit outward normal. Structurally matches
 *  `MutStructureSocket` / `StructureSocket` (shared-types). */
export interface CableEnd {
  readonly x: number;
  readonly y: number;
  readonly nx: number;
  readonly ny: number;
}

/** Caller-owned scratch box for a flattened curve. */
export interface CableBox { x0: number; y0: number; x1: number; y1: number }

/** A fresh scratch box (allocate once, reuse). */
export function makeCableBox(): CableBox {
  return { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/**
 * Flatten the socket-to-socket curve into `out` (length ≥ `CABLE_CURVE_FLOATS`;
 * x0,y0,x1,y1,…) and its axis-aligned box into `box`. `aShort` / `bShort` mark
 * a connector end (short tail). The first point is exactly socket A, the last
 * exactly socket B; the first segment runs exactly along A's normal (the
 * stub) and the last exactly against B's. Allocation-free.
 */
export function flattenCableCurve(
  a: CableEnd, aShort: boolean,
  b: CableEnd, bShort: boolean,
  out: Float64Array,
  box: CableBox,
): void {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const k = Math.min(CABLE_TAIL_MAX, d * CABLE_TAIL_FRACTION);
  const ka = aShort ? Math.min(CABLE_SHORT_TAIL, k) : k;
  const kb = bShort ? Math.min(CABLE_SHORT_TAIL, k) : k;
  const sa = Math.min(CABLE_SOCKET_STUB, ka * 0.5), sb = Math.min(CABLE_SOCKET_STUB, kb * 0.5);
  // The curve runs stub end (p0) to stub end (p3); its controls stay `k` out
  // from the sockets, so it leaves each stub along the socket normal.
  const p0x = a.x + a.nx * sa, p0y = a.y + a.ny * sa;
  const p1x = a.x + a.nx * ka, p1y = a.y + a.ny * ka;
  const p2x = b.x + b.nx * kb, p2y = b.y + b.ny * kb;
  const p3x = b.x + b.nx * sb, p3y = b.y + b.ny * sb;
  let x0 = a.x, y0 = a.y, x1 = a.x, y1 = a.y;
  out[0] = a.x;
  out[1] = a.y;
  // Points 1 .. SEGMENTS-1: the curve at t = 0 .. 1 (its ends are the stubs').
  const inner = CABLE_CURVE_SEGMENTS - 2;
  for (let i = 1; i < CABLE_CURVE_SEGMENTS; i++) {
    const t = (i - 1) / inner;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    const x = w0 * p0x + w1 * p1x + w2 * p2x + w3 * p3x;
    const y = w0 * p0y + w1 * p1y + w2 * p2y + w3 * p3y;
    out[i * 2] = x;
    out[i * 2 + 1] = y;
    if (x < x0) x0 = x; else if (x > x1) x1 = x;
    if (y < y0) y0 = y; else if (y > y1) y1 = y;
  }
  const last = CABLE_CURVE_SEGMENTS * 2;
  out[last] = b.x;
  out[last + 1] = b.y;
  if (b.x < x0) x0 = b.x; else if (b.x > x1) x1 = b.x;
  if (b.y < y0) y0 = b.y; else if (b.y > y1) y1 = b.y;
  box.x0 = x0;
  box.y0 = y0;
  box.x1 = x1;
  box.y1 = y1;
}

/** A link end as the reach box sees it: centre plus footprint half extents
 *  (absent ⇒ a square of `radius`). A `GridNode` and a server
 *  `StructureRecord` both fit. */
export interface LinkReachEnd {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly halfW?: number | undefined;
  readonly halfH?: number | undefined;
}

/** Start the box every link from `end` lies in (0d slice 7, one rule for the
 *  server's `linkReachBox` and the build preview, #15): `end`'s footprint
 *  padded by `CABLE_TAIL_MAX`, since a cable leaves a socket on the outline
 *  and bends out at most that far along its normal. Writes `out`. */
export function linkReachBoxStart(end: LinkReachEnd, out: CableBox): void {
  const pw = (end.halfW ?? end.radius) + CABLE_TAIL_MAX, ph = (end.halfH ?? end.radius) + CABLE_TAIL_MAX;
  out.x0 = end.x - pw; out.x1 = end.x + pw;
  out.y0 = end.y - ph; out.y1 = end.y + ph;
}

/** Widen `out` (from `linkReachBoxStart(self)`) by `partner`'s padded
 *  footprint when it is within `maxRange` of `self` edge to edge (as
 *  `canConnect`'s far reject); returns whether it was. Allocation-free. */
export function linkReachBoxAdd(self: LinkReachEnd, partner: LinkReachEnd, maxRange: number, out: CableBox): boolean {
  const sw = self.halfW ?? self.radius, sh = self.halfH ?? self.radius;
  const ow = partner.halfW ?? partner.radius, oh = partner.halfH ?? partner.radius;
  const dx = Math.max(0, Math.abs(partner.x - self.x) - (sw + ow));
  const dy = Math.max(0, Math.abs(partner.y - self.y) - (sh + oh));
  if (dx * dx + dy * dy > maxRange * maxRange) return false;
  const px = ow + CABLE_TAIL_MAX, py = oh + CABLE_TAIL_MAX;
  if (partner.x - px < out.x0) out.x0 = partner.x - px;
  if (partner.x + px > out.x1) out.x1 = partner.x + px;
  if (partner.y - py < out.y0) out.y0 = partner.y - py;
  if (partner.y + py > out.y1) out.y1 = partner.y + py;
  return true;
}

/** Narrow-phase counter (count gate for tests and the scale bench): how many
 *  nodes / obstacles passed the box broad phase and got per-segment tests.
 *  Callers may reset `narrow` to 0; nothing else reads it. */
export const CABLE_BLOCK_STATS = { narrow: 0 };

/** Does any segment of the flattened polyline cross the box? */
export function cablePolylineHitsAabb(poly: Float64Array, minX: number, minY: number, maxX: number, maxY: number): boolean {
  for (let i = 0; i < CABLE_CURVE_SEGMENTS; i++) {
    const j = i * 2;
    if (segmentIntersectsAabb(poly[j]!, poly[j + 1]!, poly[j + 2]!, poly[j + 3]!, minX, minY, maxX, maxY)) return true;
  }
  return false;
}

/** A node's landing pad (its kind's `keepClear` box, `keepClearBox`) in world
 *  space, or null when the kind has none. Returns `keepClearBox`'s shared
 *  scratch: read it before the next call. Allocation-free. */
export function gridNodePadBox(n: GridNode): { readonly x: number; readonly y: number; readonly hw: number; readonly hh: number } | null {
  return keepClearBox(n.kind, n.x, n.y, (n.rot * 180) / Math.PI, n.mirror);
}

/** Does the flattened cable cross node `n`'s landing pad (solid to cables,
 *  owner rule)? False when the kind has no pad. Allocation-free. */
function polylineHitsPad(n: GridNode, poly: Float64Array, box: CableBox): boolean {
  const pad = gridNodePadBox(n);
  if (pad === null) return false;
  const minX = pad.x - pad.hw, maxX = pad.x + pad.hw, minY = pad.y - pad.hh, maxY = pad.y + pad.hh;
  if (maxX < box.x0 || minX > box.x1 || maxY < box.y0 || minY > box.y1) return false;
  CABLE_BLOCK_STATS.narrow++;
  return cablePolylineHitsAabb(poly, minX, minY, maxX, maxY);
}

/**
 * The polyline form of `isConnectionLineBlocked`: true if the flattened cable
 * (`poly`, from `flattenCableCurve`, with its `box`) passes through any node's
 * footprint box other than `a` / `b`, through ANY node's landing pad (its
 * `keepClear` box, `a`'s and `b`'s own included: a pad is solid to cables),
 * or through any `obstacle` (`segmentHitsObstacle`, parts narrow phase
 * included). A node, pad or obstacle whose box misses the curve's box is
 * skipped before the per-segment tests. `obstacles` is optional, as in
 * `isConnectionLineBlocked`. Allocation-free.
 */
export function isCablePolylineBlocked(
  a: GridNode,
  b: GridNode,
  poly: Float64Array,
  box: CableBox,
  nodes: ReadonlyMap<string, GridNode>,
  obstacles?: readonly GridObstacle[],
): boolean {
  // The ends' own pads (the build-preview ghost is not in `nodes`).
  if (polylineHitsPad(a, poly, box) || polylineHitsPad(b, poly, box)) return true;
  for (const n of nodes.values()) {
    if (n.id === a.id || n.id === b.id) continue;
    if (polylineHitsPad(n, poly, box)) return true;
    const hw = n.halfW ?? n.radius, hh = n.halfH ?? n.radius;
    const minX = n.x - hw, maxX = n.x + hw, minY = n.y - hh, maxY = n.y + hh;
    if (maxX < box.x0 || minX > box.x1 || maxY < box.y0 || minY > box.y1) continue;
    CABLE_BLOCK_STATS.narrow++;
    if (cablePolylineHitsAabb(poly, minX, minY, maxX, maxY)) return true;
  }
  if (obstacles) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i]!;
      const r = o.radius;
      if (o.x + r < box.x0 || o.x - r > box.x1 || o.y + r < box.y0 || o.y - r > box.y1) continue;
      CABLE_BLOCK_STATS.narrow++;
      for (let s = 0; s < CABLE_CURVE_SEGMENTS; s++) {
        const j = s * 2;
        if (segmentHitsObstacle(poly[j]!, poly[j + 1]!, poly[j + 2]!, poly[j + 3]!, o)) return true;
      }
    }
  }
  return false;
}

/** No socket (fence link); defined in `Connection.ts`, re-exported here. */
export { CABLE_NO_SOCKET };

/**
 * The socket pair `canConnect` picked, as indices into each end's
 * `structureSockets(kind)` list (`a` for its first node argument, `b` for its
 * second). `CABLE_NO_SOCKET` on both for a fence link. Caller-owned scratch:
 * allocate once with `makeCableSocketPick`, pass it on every call.
 */
export interface CableSocketPick { a: number; b: number }

/** A fresh scratch pick (allocate once, reuse). */
export function makeCableSocketPick(): CableSocketPick {
  return { a: CABLE_NO_SOCKET, b: CABLE_NO_SOCKET };
}

// Module scratch for the picker (root invariant #14: the build preview calls
// `canConnect` every frame). World sockets per end, then the candidate pairs
// in nearest-first order. Grown (doubled) only when a kind has more sockets
// than ever seen before, so steady state allocates nothing.
let sockCap = 32;
let ax = new Float64Array(sockCap), ay = new Float64Array(sockCap), aNx = new Float64Array(sockCap), aNy = new Float64Array(sockCap);
let bx = new Float64Array(sockCap), by = new Float64Array(sockCap), bNx = new Float64Array(sockCap), bNy = new Float64Array(sockCap);
let pairCap = 256;
let pairD2 = new Float64Array(pairCap);
let pairI = new Int32Array(pairCap);
let pairJ = new Int32Array(pairCap);
const wSock = { x: 0, y: 0, nx: 0, ny: 0 };
const endA = { x: 0, y: 0, nx: 0, ny: 0 };
const endB = { x: 0, y: 0, nx: 0, ny: 0 };
const pickPoly = new Float64Array(CABLE_CURVE_FLOATS);
const pickBox = makeCableBox();

function growSockets(n: number): void {
  while (sockCap < n) sockCap *= 2;
  ax = new Float64Array(sockCap); ay = new Float64Array(sockCap); aNx = new Float64Array(sockCap); aNy = new Float64Array(sockCap);
  bx = new Float64Array(sockCap); by = new Float64Array(sockCap); bNx = new Float64Array(sockCap); bNy = new Float64Array(sockCap);
}

function growPairs(n: number): void {
  while (pairCap < n) pairCap *= 2;
  pairD2 = new Float64Array(pairCap);
  pairI = new Int32Array(pairCap);
  pairJ = new Int32Array(pairCap);
}

/** Ends that take a cable from any side (short tail): a connector (its faces
 *  still face the partner, one cable per socket), and the kinds whose links
 *  are NOT socket-bound (`structureLinksBoundBySockets`, the one source, may
 *  share a socket): a shield emitter (pylon / gate / airlock), whose sockets
 *  are its round posts rather than wall faces. Without the emitter case a gate
 *  could never be tapped from beside its middle (the base generator's row-end
 *  taps and the scale lattice both do that): a gate's posts point along the
 *  wall, not at its taps. */
function takesAnySide(n: GridNode): boolean {
  return n.isConnector || !structureLinksBoundBySockets(n.kind);
}

/** Bits in a used-socket mask (one per socket index). Every kind has fewer
 *  sockets than this (pinned by a test); a higher index is never marked. */
export const CABLE_SOCKET_MASK_BITS = 32;

/** Is socket `i` marked in `mask`? */
function socketUsed(mask: number, i: number): boolean {
  return i < CABLE_SOCKET_MASK_BITS && ((mask >>> i) & 1) === 1;
}

/** Mark socket `s` in `mask` (a fence link's `CABLE_NO_SOCKET` marks nothing). */
function markSocket(mask: number, s: number): number {
  return s >= 0 && s < CABLE_SOCKET_MASK_BITS ? (mask | (1 << s)) >>> 0 : mask;
}

/** Bit mask of the sockets node `id`'s stored links hold (`socketAt(id)` of
 *  each). Allocation-free; `canConnect` reads it from the adjacency. */
export function linkSocketMask(id: string, conns: readonly Connection[]): number {
  let m = 0;
  for (let c = 0; c < conns.length; c++) m = markSocket(m, conns[c]!.socketAt(id));
  return m;
}

/** The same mask from a per-link socket list (the client mirror's
 *  `connSockSelf`, parallel to `connTo`). Allocation-free. */
export function socketListMask(sockets: readonly number[] | undefined): number {
  let m = 0;
  if (sockets !== undefined) for (let c = 0; c < sockets.length; c++) m = markSocket(m, sockets[c]!);
  return m;
}

/**
 * The socket half of `canConnect` (0d slice 4, owner-approved rule): find the
 * socket pair a cable from `a` to `b` runs between, writing it into `out`.
 *
 *  0. One cable per stud (owner rule): on a socket-bound end a socket already
 *     holding a cable (`usedA` / `usedB`, bit masks: `linkSocketMask`) is
 *     skipped (a connector too). An emitter end ignores its mask and shares.
 *  1. Facing filter: a building socket takes a cable only to a partner socket
 *     in front of it (within 90° of its outward normal, never behind the
 *     building). A connector takes a cable from any side, but on a face
 *     turned toward the partner (within 90°), so a cable never runs back
 *     across its own hub; an emitter-post end takes it from any side
 *     (`takesAnySide`).
 *  2. Reach: socket to socket within `maxRange`, and at least
 *     `MIN_CABLE_LENGTH` (owner: "keep buildings apart"). A shorter pair is
 *     skipped, so a longer free facing pair still links.
 *  3. The survivors are tried nearest first (ties: `a`'s socket order, then
 *     `b`'s, so the pick is deterministic), and the first whose curve
 *     (`flattenCableCurve`, any-side ends short-tailed) is not blocked
 *     (`isCablePolylineBlocked`) and, given `adjacency`, crosses no stored
 *     cable (`cableCrossesExisting`, owner rule) wins.
 *
 * Returns null on success, else the refusal: `'no-facing-socket'` (no free
 * pair faces at all), `'out-of-range'` (none facing is in reach), `'too-short'`
 * (a facing pair in reach is under `MIN_CABLE_LENGTH`, and no pair long enough
 * links), `'crosses-cable'` (an unblocked pair crosses a stored cable, and none
 * links; `out` gets the first such pair, the preview draws it red) or `'blocked'` (every facing pair in reach crosses something). `out`
 * gets the pick on success, the nearest too-short pair on `'too-short'` (the
 * build preview draws it refused, stud to stud), `CABLE_NO_SOCKET` on
 * `'blocked'`, and is left alone otherwise. Allocation-free after warm-up.
 */
export function pickCableSocketPair(
  a: GridNode,
  b: GridNode,
  maxRange: number,
  nodes: ReadonlyMap<string, GridNode>,
  obstacles: readonly GridObstacle[] | undefined,
  out: CableSocketPick | undefined,
  usedA = 0,
  usedB = 0,
  adjacency?: ReadonlyMap<string, readonly Connection[]>,
): CanConnectReason | null {
  const la = structureSockets(a.kind);
  const lb = structureSockets(b.kind);
  const na = la.length, nb = lb.length;
  if (na > sockCap || nb > sockCap) growSockets(Math.max(na, nb));
  if (na * nb > pairCap) growPairs(na * nb);
  for (let i = 0; i < na; i++) {
    structureSocketToWorld(la[i]!, a.x, a.y, a.rot, wSock, a.mirror);
    ax[i] = wSock.x; ay[i] = wSock.y; aNx[i] = wSock.nx; aNy[i] = wSock.ny;
  }
  for (let j = 0; j < nb; j++) {
    structureSocketToWorld(lb[j]!, b.x, b.y, b.rot, wSock, b.mirror);
    bx[j] = wSock.x; by[j] = wSock.y; bNx[j] = wSock.nx; bNy[j] = wSock.ny;
  }
  const aAny = takesAnySide(a), bAny = takesAnySide(b);
  // A connector's faces still face the partner (no cable back across the hub).
  const aFace = !aAny || a.isConnector, bFace = !bAny || b.isConnector;
  const ua = structureLinksBoundBySockets(a.kind) ? usedA : 0, ub = structureLinksBoundBySockets(b.kind) ? usedB : 0;
  const max2 = maxRange * maxRange;
  const min2 = MIN_CABLE_LENGTH * MIN_CABLE_LENGTH;
  let facing = false;
  let n = 0;
  let shortD2 = Infinity, shortI = CABLE_NO_SOCKET, shortJ = CABLE_NO_SOCKET;
  let crossI = CABLE_NO_SOCKET, crossJ = CABLE_NO_SOCKET;
  for (let i = 0; i < na; i++) {
    if (socketUsed(ua, i)) continue;
    for (let j = 0; j < nb; j++) {
      if (socketUsed(ub, j)) continue;
      const dx = bx[j]! - ax[i]!, dy = by[j]! - ay[i]!;
      // (FACE_EPS: a stud at exactly 90° faces; its normal's float noise never turns it away.)
      if (aFace && aNx[i]! * dx + aNy[i]! * dy < -FACE_EPS) continue;
      if (bFace && bNx[j]! * dx + bNy[j]! * dy > FACE_EPS) continue;
      facing = true;
      const d2 = dx * dx + dy * dy;
      if (d2 > max2) continue;
      if (d2 < min2) {
        if (d2 < shortD2) { shortD2 = d2; shortI = i; shortJ = j; }
        continue;
      }
      // Insertion into the sorted list; equal distances keep (i, j) order.
      let k = n++;
      while (k > 0 && pairD2[k - 1]! > d2) {
        pairD2[k] = pairD2[k - 1]!; pairI[k] = pairI[k - 1]!; pairJ[k] = pairJ[k - 1]!;
        k--;
      }
      pairD2[k] = d2; pairI[k] = i; pairJ[k] = j;
    }
  }
  if (n === 0 && shortI === CABLE_NO_SOCKET) return facing ? 'out-of-range' : 'no-facing-socket';
  for (let k = 0; k < n; k++) {
    const i = pairI[k]!, j = pairJ[k]!;
    endA.x = ax[i]!; endA.y = ay[i]!; endA.nx = aNx[i]!; endA.ny = aNy[i]!;
    endB.x = bx[j]!; endB.y = by[j]!; endB.nx = bNx[j]!; endB.ny = bNy[j]!;
    flattenCableCurve(endA, aAny, endB, bAny, pickPoly, pickBox);
    if (isCablePolylineBlocked(a, b, pickPoly, pickBox, nodes, obstacles)) continue;
    if (adjacency !== undefined && cableCrossesExisting(a, b, pickPoly, pickBox, adjacency, nodes)) {
      if (crossI === CABLE_NO_SOCKET) { crossI = i; crossJ = j; }
      continue;
    }
    if (out) { out.a = i; out.b = j; }
    return null;
  }
  if (crossI !== CABLE_NO_SOCKET) {
    if (out) { out.a = crossI; out.b = crossJ; }
    return 'crosses-cable';
  }
  if (shortI !== CABLE_NO_SOCKET) {
    if (out) { out.a = shortI; out.b = shortJ; }
    return 'too-short';
  }
  if (out) { out.a = CABLE_NO_SOCKET; out.b = CABLE_NO_SOCKET; }
  return 'blocked';
}

/**
 * Flatten the cable a stored link runs along (`Connection.socketA` /
 * `socketB`, as `canConnect` picked them) into `out` + `box`, the same
 * curve `pickCableSocketPair` tested: any-side ends short-tailed. A fence
 * link (either end `CABLE_NO_SOCKET`) is the straight centre-to-centre line,
 * written as the same fixed-length polyline so callers treat both alike.
 * Allocation-free.
 */
export function flattenLinkCable(
  a: GridNode, socketA: number,
  b: GridNode, socketB: number,
  out: Float64Array,
  box: CableBox,
): void {
  const la = structureSockets(a.kind), lb = structureSockets(b.kind);
  const sa = socketA === CABLE_NO_SOCKET ? undefined : la[socketA];
  const sb = socketB === CABLE_NO_SOCKET ? undefined : lb[socketB];
  if (sa === undefined || sb === undefined) {
    for (let i = 0; i <= CABLE_CURVE_SEGMENTS; i++) {
      const t = i / CABLE_CURVE_SEGMENTS;
      out[i * 2] = a.x + (b.x - a.x) * t;
      out[i * 2 + 1] = a.y + (b.y - a.y) * t;
    }
    box.x0 = Math.min(a.x, b.x); box.x1 = Math.max(a.x, b.x);
    box.y0 = Math.min(a.y, b.y); box.y1 = Math.max(a.y, b.y);
    return;
  }
  structureSocketToWorld(sa, a.x, a.y, a.rot, endA, a.mirror);
  structureSocketToWorld(sb, b.x, b.y, b.rot, endB, b.mirror);
  flattenCableCurve(endA, takesAnySide(a), endB, takesAnySide(b), out, box);
}

// ── Cables never cross (owner rule) ─────────────────────────────────────────

/** Count gate for the crossing test (tests read it; never a wall clock):
 *  `links` existing cables that passed the box broad phase and were
 *  flattened, `segTests` segment-pair orientation tests run. Callers may
 *  reset both to 0; nothing else reads them. */
export const CABLE_CROSS_STATS = { links: 0, segTests: 0 };

/** Scratch for an existing link's flattened cable (#14). */
const crossPoly = new Float64Array(CABLE_CURVE_FLOATS);
const crossBox = makeCableBox();

/** Is a stored link a shield-fence link (emitter post to post)? A fence is a
 *  wall, not a cable: it neither blocks a cable nor is blocked by one. */
function isFenceLink(a: GridNode, b: GridNode): boolean {
  return a.isShieldPylon === true && b.isShieldPylon === true;
}

/** Twice the signed area of (p, q, r): > 0 left turn, < 0 right turn. */
function orient(px: number, py: number, qx: number, qy: number, rx: number, ry: number): number {
  return (qx - px) * (ry - py) - (qy - py) * (rx - px);
}

/** Does any segment of `p` cross any segment of `q` (box `qb`)? Collinear
 *  overlap is not a crossing; passing through a vertex is. Each `p`
 *  segment's box is tested against `qb`, each pair's boxes against each
 *  other, before the orientation test. Allocation-free. */
function polylinesCross(p: Float64Array, q: Float64Array, qb: CableBox): boolean {
  for (let i = 0; i < CABLE_CURVE_SEGMENTS; i++) {
    const k = i * 2;
    const ax = p[k]!, ay = p[k + 1]!, bx = p[k + 2]!, by = p[k + 3]!;
    const sx0 = Math.min(ax, bx), sx1 = Math.max(ax, bx), sy0 = Math.min(ay, by), sy1 = Math.max(ay, by);
    if (sx1 < qb.x0 || sx0 > qb.x1 || sy1 < qb.y0 || sy0 > qb.y1) continue;
    for (let j = 0; j < CABLE_CURVE_SEGMENTS; j++) {
      const m = j * 2;
      const cx = q[m]!, cy = q[m + 1]!, dx = q[m + 2]!, dy = q[m + 3]!;
      if (Math.max(cx, dx) < sx0 || Math.min(cx, dx) > sx1 || Math.max(cy, dy) < sy0 || Math.min(cy, dy) > sy1) continue;
      CABLE_CROSS_STATS.segTests++;
      // Half-open sides (> 0 vs ≤ 0): a cable passing exactly through the
      // other's vertex crosses one of the two segments there, not neither.
      if (orient(ax, ay, bx, by, cx, cy) > 0 === orient(ax, ay, bx, by, dx, dy) > 0) continue;
      if (orient(cx, cy, dx, dy, ax, ay) > 0 !== orient(cx, cy, dx, dy, bx, by) > 0) return true;
    }
  }
  return false;
}

/** Could the cable of a link between `n` and `o` reach `box`? Each end's
 *  footprint padded by `CABLE_TAIL_MAX` bounds its cable (`linkReachBoxStart`'s
 *  rule), so a miss here means no crossing. Allocation-free. */
function linkMayReach(n: GridNode, o: GridNode, box: CableBox): boolean {
  const nw = (n.halfW ?? n.radius) + CABLE_TAIL_MAX, nh = (n.halfH ?? n.radius) + CABLE_TAIL_MAX;
  const ow = (o.halfW ?? o.radius) + CABLE_TAIL_MAX, oh = (o.halfH ?? o.radius) + CABLE_TAIL_MAX;
  const x0 = Math.min(n.x - nw, o.x - ow), x1 = Math.max(n.x + nw, o.x + ow);
  const y0 = Math.min(n.y - nh, o.y - oh), y1 = Math.max(n.y + nh, o.y + oh);
  return !(x1 < box.x0 || x0 > box.x1 || y1 < box.y0 || y0 > box.y1);
}

/**
 * Would the new `a`–`b` cable (`poly` + `box`, from `flattenCableCurve`)
 * cross any stored cable in `adjacency` (owner rule: cables never cross)?
 * Every owner's links count, as every owner's buildings block a cable. A
 * link sharing an end with the new one (a fan-out from the same structure)
 * is skipped, as is a fence link and a link with an end missing from `nodes`.
 * Each link is visited once (from its lower-id end; `adjacency` lists a link
 * under both ends), box-tested before it is flattened. Allocation-free.
 */
export function cableCrossesExisting(
  a: GridNode,
  b: GridNode,
  poly: Float64Array,
  box: CableBox,
  adjacency: ReadonlyMap<string, readonly Connection[]>,
  nodes: ReadonlyMap<string, GridNode>,
): boolean {
  for (const id of adjacency.keys()) {
    if (id === a.id || id === b.id) continue;
    const conns = adjacency.get(id)!;
    for (let c = 0; c < conns.length; c++) {
      const link = conns[c]!;
      const other = link.getOtherNode(id);
      if (other === null || other < id || other === a.id || other === b.id) continue;
      const n = nodes.get(id), o = nodes.get(other);
      if (n === undefined || o === undefined || isFenceLink(n, o) || !linkMayReach(n, o, box)) continue;
      CABLE_CROSS_STATS.links++;
      flattenLinkCable(n, link.socketAt(id), o, link.socketAt(other), crossPoly, crossBox);
      if (crossBox.x1 < box.x0 || crossBox.x0 > box.x1 || crossBox.y1 < box.y0 || crossBox.y0 > box.y1) continue;
      if (polylinesCross(poly, crossPoly, crossBox)) return true;
    }
  }
  return false;
}
