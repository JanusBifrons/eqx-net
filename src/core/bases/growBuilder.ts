/** The base generator's placement checker (`growBase.ts`, step 2: "Lay
 *  out"): every placement passes the real `placementRejection` and every
 *  edge the real `canConnect`, AS the base is built. */
import { getStructureKind, isConnectorKind, structureHalfExtents, structureSockets, type StructureKindId } from '../../shared-types/structureKinds.js';
import { canConnect, type GridNode } from '../structures/Grid.js';
import { Connection } from '../structures/Connection.js';
import {
  CABLE_CURVE_FLOATS, cablePolylineHitsAabb, flattenLinkCable, makeCableBox, makeCableSocketPick,
} from '../structures/cableCurve.js';
import { keepClearBox, placementRejection } from '../structures/placementRules.js';
import { isShieldEmitterKind } from '../structures/gateGeometry.js';
import { MIN_CABLE_LENGTH } from '../structures/structureGridConstants.js';
import type { RecipeId } from '../../shared-types/recipes.js';

export interface GrownPlacement {
  kind: StructureKindId;
  x: number;
  y: number;
  rot?: number;
  /** Selected recipe (processors). */
  recipe?: RecipeId;
  level?: number;
  /** v4 H — the transit link this teleporter ends (paired at run time). */
  link?: string;
}

interface Node extends GridNode {
  kind: StructureKindId;
}

// Scratch for the cable socket pick and the curve test (seed-time, but reused
// all the same: root invariant #14).
/** How far a bastion moves off its row line when a fence post blocks it,
 *  and the lines tried in order (on the row first). */
export const BASTION_NUDGE = 150;
const BASTION_TRIES = [0, BASTION_NUDGE, -BASTION_NUDGE] as const;
const CONN_HALF = getStructureKind('connector').footprint.h / 2;
/** Most centre-to-centre span, less a connector, one relay hop covers (the
 *  spine's and `reachOut`'s step; under the 600 u link range). */
export const RELAY_SPAN = 560;
const linkPick = makeCableSocketPick();
const linkPoly = new Float64Array(CABLE_CURVE_FLOATS);
const linkBox = makeCableBox();

export class Builder {
  readonly placements: GrownPlacement[] = [];
  readonly edges: Array<readonly [number, number]> = [];
  readonly placed: Array<{ x: number; y: number; radius: number; halfW: number; halfH: number; kind: StructureKindId; rot: number }> = [];
  readonly nodes = new Map<string, Node>();
  readonly adj = new Map<string, Connection[]>();
  /** Per edge (same order as `edges`): the socket pair its cable runs
   *  between (`Connection.socketA` / `socketB`). */
  readonly edgeSockets: Array<readonly [number, number]> = [];
  private cid = 0;

  /** Place if the real overlap rule allows; returns the index or -1. */
  tryPlace(p: GrownPlacement): number {
    const rot = p.rot ?? 0;
    if (placementRejection(p.kind, p.x, p.y, this.placed, null, rot) !== null) return -1;
    const k = getStructureKind(p.kind);
    const { hw, hh } = structureHalfExtents(p.kind, rot);
    // Never on top of an existing link's cable: the curve between the
    // sockets it was linked with (0d slice 5), as `canConnect` tested it.
    // Its landing pad (`keepClear`) is solid to cables too: never over one.
    const x0 = p.x - hw, y0 = p.y - hh, x1 = p.x + hw, y1 = p.y + hh;
    const pad = keepClearBox(p.kind, p.x, p.y, rot);
    const px0 = pad === null ? 0 : pad.x - pad.hw, px1 = pad === null ? 0 : pad.x + pad.hw;
    const py0 = pad === null ? 0 : pad.y - pad.hh, py1 = pad === null ? 0 : pad.y + pad.hh;
    for (let e = 0; e < this.edges.length; e++) {
      const [ea, eb] = this.edges[e]!;
      const s = this.edgeSockets[e]!;
      flattenLinkCable(this.nodes.get(`s${ea}`)!, s[0], this.nodes.get(`s${eb}`)!, s[1], linkPoly, linkBox);
      if (!(linkBox.x1 < x0 || linkBox.x0 > x1 || linkBox.y1 < y0 || linkBox.y0 > y1)
        && cablePolylineHitsAabb(linkPoly, x0, y0, x1, y1)) return -1;
      if (pad !== null && !(linkBox.x1 < px0 || linkBox.x0 > px1 || linkBox.y1 < py0 || linkBox.y0 > py1)
        && cablePolylineHitsAabb(linkPoly, px0, py0, px1, py1)) return -1;
    }
    const i = this.placements.length;
    this.placements.push(p);
    this.placed.push({ x: p.x, y: p.y, radius: k.radius, halfW: hw, halfH: hh, kind: p.kind, rot });
    this.nodes.set(`s${i}`, {
      id: `s${i}`, kind: p.kind, x: p.x, y: p.y, rot: (rot * Math.PI) / 180, radius: k.radius, halfW: hw, halfH: hh,
      isHub: k.isHub, isCapital: p.kind === 'capital', isConnector: isConnectorKind(p.kind),
      isShieldPylon: isShieldEmitterKind(p.kind), maxConnections: k.maxConnections,
      connectionRange: k.connectionRange, powerOutput: k.powerOutput, powerConsumption: k.powerConsumption,
      isConstructed: true,
    });
    return i;
  }

  /** Link if the real connection rule allows. */
  tryLink(a: number, b: number): boolean {
    const na = this.nodes.get(`s${a}`)!, nb = this.nodes.get(`s${b}`)!;
    const r = canConnect(na, nb, this.adj, this.nodes, undefined, linkPick);
    if (!r.ok) return false;
    const c = new Connection(this.cid++, na.id, nb.id, 1, linkPick.a, linkPick.b);
    (this.adj.get(na.id) ?? this.adj.set(na.id, []).get(na.id)!).push(c);
    (this.adj.get(nb.id) ?? this.adj.set(nb.id, []).get(nb.id)!).push(c);
    this.edges.push([a, b]);
    this.edgeSockets.push([linkPick.a, linkPick.b]);
    return true;
  }

  /** Place `p` and link it from `from`; if the link fails the placement is
   *  taken back (never left orphaned). Returns the index or -1. */
  placeLinked(p: GrownPlacement, from: number): number {
    const i = this.tryPlace(p);
    if (i < 0) return -1;
    if (!this.tryLink(from, i)) { this.undoLast(); return -1; }
    return i;
  }

  /** Connectors at `(x0 + k·dx, y)`, k = 0…n-1, each linked to the one
   *  before (the first to `from`); stops at the first that fails. */
  chainConnectors(from: number, x0: number, dx: number, y: number, n: number): number[] {
    const out: number[] = [];
    for (let k = 0, prev = from; k < n; k++) {
      const ci = this.placeLinked({ kind: 'connector', x: x0 + k * dx, y }, prev);
      if (ci < 0) break;
      out.push(ci);
      prev = ci;
    }
    return out;
  }

  /** Remove the last placement (a leaf that couldn't be linked). */
  undoLast(): void {
    const i = this.placements.length - 1;
    this.placements.pop();
    this.placed.pop();
    this.nodes.delete(`s${i}`);
  }

  /** Remove the last link (both ends' adjacency, its edge and sockets). */
  unlinkLast(): void {
    const [a, b] = this.edges.pop()!;
    this.edgeSockets.pop();
    this.adj.get(`s${a}`)!.pop();
    this.adj.get(`s${b}`)!.pop();
    this.cid--;
  }

  /** A bastion off row end `end`: a relay at `relayX` and a hub at `hubX`,
   *  linked end → relay → hub along the row line, or `BASTION_NUDGE` above or
   *  below it when a fence post sits on the line (a connector holds one cable
   *  per socket, so the cable can no longer share a face to bend round it).
   *  The relay stands at least a `linkGap` off the row end (minimum cable
   *  length), and a line with anything standing between relay and hub is
   *  skipped: the cable would bend round it over the hub's faces the guns
   *  need. Returns the hub and its y, or null. A relay whose hub fails to
   *  place or link on every line stays linked to the row, as before. */
  bastion(end: number, relayX: number, hubX: number, y: number): { hub: number; y: number } | null {
    const ex = this.placements[end]!.x, sx = Math.sign(relayX - ex);
    relayX = ex + sx * Math.max(Math.abs(relayX - ex), 2 * CONN_HALF + linkGap('connector', sx, 0));
    const lx0 = Math.min(relayX, hubX) + CONN_HALF, lx1 = Math.max(relayX, hubX) - CONN_HALF;
    for (const dy of BASTION_TRIES) {
      const ly = y + dy;
      if (this.placed.some((q) => q.x + q.halfW > lx0 && q.x - q.halfW < lx1 && Math.abs(q.y - ly) < q.halfH + CONN_HALF)) continue;
      const relay = this.tryPlace({ kind: 'connector', x: relayX, y: ly });
      if (relay < 0) continue;
      if (!this.tryLink(end, relay)) { this.undoLast(); continue; }
      const hub = this.tryPlace({ kind: 'connector', x: hubX, y: ly });
      if (hub >= 0 && this.tryLink(relay, hub)) return { hub, y: ly };
      if (hub >= 0) this.undoLast();
      if (dy === BASTION_TRIES[BASTION_TRIES.length - 1]) return null;
      this.unlinkLast();
      this.undoLast();
    }
    return null;
  }

  /** A straight run of connectors `span` out from `from` along +y, in hops
   *  of at most `RELAY_SPAN` (a span past the link range gets relays).
   *  Returns the last connector, or -1 with everything it placed taken back. */
  reachOut(from: number, span: number): number {
    const { x, y } = this.placements[from]!;
    const n0 = this.placements.length, e0 = this.edges.length;
    const hops = Math.max(1, Math.ceil((span - 2 * CONN_HALF) / RELAY_SPAN));
    let prev = from;
    for (let k = 1; k <= hops && prev >= 0; k++) prev = this.placeLinked({ kind: 'connector', x, y: y + (span * k) / hops }, prev);
    if (prev >= 0) return prev;
    while (this.edges.length > e0) this.unlinkLast();
    while (this.placements.length > n0) this.undoLast();
    return -1;
  }
}

/** Mask of the connector sockets NOT turned most toward (`dx`, `dy`) (ties
 *  kept free together). */
function facesAwayFrom(dx: number, dy: number): number {
  const socks = structureSockets('connector');
  let best = -Infinity;
  for (const k of socks) best = Math.max(best, k.nx * dx + k.ny * dy);
  let m = 0;
  socks.forEach((k, i) => { if (k.nx * dx + k.ny * dy < best - 1e-6) m |= 1 << i; });
  return m;
}

const linkGaps = new Map<string, number>();
/** The smallest box gap (from `minGap`, in steps of 2) at which `kind`,
 *  turned `rot`, set square off a lone connector in direction (`dx`, `dy`),
 *  links it under the real `canConnect`: at least `MIN_CABLE_LENGTH` apart,
 *  box edge to box edge ("keep buildings apart", one clear cable section
 *  between them), and a facing socket pair whose cable is clear. The connector holds one cable per socket, so the probe leaves free only
 *  its faces turned most toward the leaf: a row's own links may hold the
 *  others. Cached per kind, direction and turn (seed-time only). */
export function linkGap(kind: StructureKindId, dx: number, dy: number, rot = 0, minGap = 20): number {
  const key = `${kind}|${dx}|${dy}|${rot}|${minGap}`;
  const hit = linkGaps.get(key);
  if (hit !== undefined) return hit;
  const ch = getStructureKind('connector').footprint.h / 2;
  const { hw, hh } = structureHalfExtents(kind, rot);
  let g = minGap;
  for (; g < MIN_CABLE_LENGTH + 2 * ch; g += 2) {
    const b = new Builder();
    b.tryPlace({ kind: 'connector', x: 0, y: 0 });
    b.nodes.get('s0')!.usedSockets = facesAwayFrom(dx, dy);
    const off = ch + g + (dx !== 0 ? hw : hh);
    if (b.tryPlace({ kind, x: dx * off, y: dy * off, rot }) >= 0 && b.tryLink(0, 1)) break;
  }
  linkGaps.set(key, g);
  return g;
}

/** How far a leaf of `kind` reaches out from its row line: half a
 *  connector, its `linkGap`, then its full height (the larger of its two
 *  sides; a keep-clear kind on the -y side turns its apron away), turned
 *  `rot` (a bastion's arc-limited gun faces out). */
export function leafReach(kind: StructureKindId, rot = 0): number {
  const k = getStructureKind(kind);
  const ch = getStructureKind('connector').footprint.h / 2;
  let r = 0;
  for (const s of [1, -1]) {
    const turn = k.keepClear !== undefined && s < 0 ? 180 : rot;
    r = Math.max(r, ch + linkGap(kind, 0, s, turn) + 2 * structureHalfExtents(kind, turn).hh);
  }
  return r;
}

/** Per index, the tallest `leafReach` from that leaf to the end of the list
 *  (what can still face into a new row gap). */
export function tallestFrom(kinds: readonly StructureKindId[]): number[] {
  const out = kinds.map((k) => leafReach(k));
  for (let i = out.length - 2; i >= 0; i--) out[i] = Math.max(out[i]!, out[i + 1]!);
  return out;
}

/** The tallest reach of a fenced base's bastion guns that hang above or
 *  below a hub: the biggest third take the hubs' outward slots (a hub seats
 *  up to three), the rest go above and below. At least half a connector. */
export function upDownGunReach(posts: readonly StructureKindId[], rotOf: (k: StructureKindId) => number): number {
  const area = (k: StructureKindId): number => getStructureKind(k).footprint.w * getStructureKind(k).footprint.h;
  const upDown = [...posts].sort((a, b) => area(b) - area(a)).slice(Math.ceil(posts.length / 3));
  return Math.max(getStructureKind('connector').footprint.h / 2, ...upDown.map((k) => leafReach(k, rotOf(k))));
}
