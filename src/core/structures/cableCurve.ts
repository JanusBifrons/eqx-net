/**
 * Cable curve (structure restyle stage 4, 0d "cable sockets", slice 3).
 *
 * A cable runs socket to socket as one cubic Bezier: from socket A out along
 * A's outward normal, bending round to come into socket B along B's normal
 * (the owner-approved concept page). Control points sit `k` along each normal,
 * `k = min(CABLE_TAIL_MAX, d * CABLE_TAIL_FRACTION)` for socket distance `d`;
 * a connector end (small, round, takes a cable from any side) uses a short
 * tail `min(CABLE_SHORT_TAIL, k)`.
 *
 * `flattenCableCurve` turns the curve into a fixed `CABLE_CURVE_SEGMENTS`
 * polyline in a caller-owned Float64Array plus its box, allocation-free (the
 * build preview runs this every frame on a phone). `isCablePolylineBlocked`
 * is the polyline form of `isConnectionLineBlocked` (Grid.ts): same nodes and
 * obstacles count, the two endpoints are ignored, and it reuses the same
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
import { CABLE_NO_SOCKET } from './Connection.js';

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
 * exactly socket B, and the curve leaves A along A's normal and enters B
 * against B's normal. Allocation-free.
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
  const p0x = a.x, p0y = a.y;
  const p1x = a.x + a.nx * ka, p1y = a.y + a.ny * ka;
  const p2x = b.x + b.nx * kb, p2y = b.y + b.ny * kb;
  const p3x = b.x, p3y = b.y;
  let x0 = p0x, y0 = p0y, x1 = p0x, y1 = p0y;
  out[0] = p0x;
  out[1] = p0y;
  for (let i = 1; i < CABLE_CURVE_SEGMENTS; i++) {
    const t = i / CABLE_CURVE_SEGMENTS;
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
  out[last] = p3x;
  out[last + 1] = p3y;
  if (p3x < x0) x0 = p3x; else if (p3x > x1) x1 = p3x;
  if (p3y < y0) y0 = p3y; else if (p3y > y1) y1 = p3y;
  box.x0 = x0;
  box.y0 = y0;
  box.x1 = x1;
  box.y1 = y1;
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

/**
 * The polyline form of `isConnectionLineBlocked`: true if the flattened cable
 * (`poly`, from `flattenCableCurve`, with its `box`) passes through any node's
 * footprint box other than `a` / `b`, or through any `obstacle`
 * (`segmentHitsObstacle`, parts narrow phase included). A node or obstacle
 * whose box misses the curve's box is skipped before the per-segment tests.
 * `obstacles` is optional, as in `isConnectionLineBlocked`. Allocation-free.
 */
export function isCablePolylineBlocked(
  a: GridNode,
  b: GridNode,
  poly: Float64Array,
  box: CableBox,
  nodes: ReadonlyMap<string, GridNode>,
  obstacles?: readonly GridObstacle[],
): boolean {
  for (const n of nodes.values()) {
    if (n.id === a.id || n.id === b.id) continue;
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

/** Ends that take a cable from any side (no facing filter, short tail): a
 *  connector, and a shield emitter (pylon / gate / airlock), whose sockets are
 *  its round posts rather than wall faces. Without the emitter case a gate
 *  could never be tapped from beside its middle (the base generator's row-end
 *  taps and the scale lattice both do that). */
// Emitters count as any-side because a gate's posts point along the wall, not at its taps.
function takesAnySide(n: GridNode): boolean {
  return n.isConnector || n.isShieldPylon === true;
}

/**
 * The socket half of `canConnect` (0d slice 4, owner-approved rule): find the
 * socket pair a cable from `a` to `b` runs between, writing it into `out`.
 *
 *  1. Facing filter: a building socket takes a cable only to a partner socket
 *     in front of it (within 90° of its outward normal, never behind the
 *     building); a connector or emitter-post end takes a cable from any side
 *     (`takesAnySide`).
 *  2. Reach: socket to socket within `maxRange`.
 *  3. The survivors are tried nearest first (ties: `a`'s socket order, then
 *     `b`'s, so the pick is deterministic), and the first whose curve
 *     (`flattenCableCurve`, any-side ends short-tailed) is not blocked
 *     (`isCablePolylineBlocked`) wins.
 *
 * Returns null on success, else the refusal: `'no-facing-socket'` (no pair
 * faces at all), `'out-of-range'` (none facing is in reach) or `'blocked'`
 * (every facing pair in reach crosses something). `out` is written only on
 * success. Allocation-free after warm-up.
 */
export function pickCableSocketPair(
  a: GridNode,
  b: GridNode,
  maxRange: number,
  nodes: ReadonlyMap<string, GridNode>,
  obstacles: readonly GridObstacle[] | undefined,
  out: CableSocketPick | undefined,
): CanConnectReason | null {
  const la = structureSockets(a.kind);
  const lb = structureSockets(b.kind);
  const na = la.length, nb = lb.length;
  if (na > sockCap || nb > sockCap) growSockets(Math.max(na, nb));
  if (na * nb > pairCap) growPairs(na * nb);
  for (let i = 0; i < na; i++) {
    structureSocketToWorld(la[i]!, a.x, a.y, a.rot, wSock);
    ax[i] = wSock.x; ay[i] = wSock.y; aNx[i] = wSock.nx; aNy[i] = wSock.ny;
  }
  for (let j = 0; j < nb; j++) {
    structureSocketToWorld(lb[j]!, b.x, b.y, b.rot, wSock);
    bx[j] = wSock.x; by[j] = wSock.y; bNx[j] = wSock.nx; bNy[j] = wSock.ny;
  }
  const aAny = takesAnySide(a), bAny = takesAnySide(b);
  const max2 = maxRange * maxRange;
  let facing = false;
  let n = 0;
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      const dx = bx[j]! - ax[i]!, dy = by[j]! - ay[i]!;
      if (!aAny && aNx[i]! * dx + aNy[i]! * dy < 0) continue;
      if (!bAny && bNx[j]! * dx + bNy[j]! * dy > 0) continue;
      facing = true;
      const d2 = dx * dx + dy * dy;
      if (d2 > max2) continue;
      // Insertion into the sorted list; equal distances keep (i, j) order.
      let k = n++;
      while (k > 0 && pairD2[k - 1]! > d2) {
        pairD2[k] = pairD2[k - 1]!; pairI[k] = pairI[k - 1]!; pairJ[k] = pairJ[k - 1]!;
        k--;
      }
      pairD2[k] = d2; pairI[k] = i; pairJ[k] = j;
    }
  }
  if (n === 0) return facing ? 'out-of-range' : 'no-facing-socket';
  for (let k = 0; k < n; k++) {
    const i = pairI[k]!, j = pairJ[k]!;
    endA.x = ax[i]!; endA.y = ay[i]!; endA.nx = aNx[i]!; endA.ny = aNy[i]!;
    endB.x = bx[j]!; endB.y = by[j]!; endB.nx = bNx[j]!; endB.ny = bNy[j]!;
    flattenCableCurve(endA, aAny, endB, bAny, pickPoly, pickBox);
    if (isCablePolylineBlocked(a, b, pickPoly, pickBox, nodes, obstacles)) continue;
    if (out) { out.a = i; out.b = j; }
    return null;
  }
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
  structureSocketToWorld(sa, a.x, a.y, a.rot, endA);
  structureSocketToWorld(sb, b.x, b.y, b.rot, endB);
  flattenCableCurve(endA, takesAnySide(a), endB, takesAnySide(b), out, box);
}
