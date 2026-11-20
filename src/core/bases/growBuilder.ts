/** The base generator's placement checker (`growBase.ts`, step 2: "Lay
 *  out"): every placement passes the real `placementRejection` and every
 *  edge the real `canConnect`, AS the base is built. */
import { getStructureKind, structureHalfExtents, type StructureKindId } from '../../shared-types/structureKinds.js';
import { canConnect, type GridNode } from '../structures/Grid.js';
import { Connection } from '../structures/Connection.js';
import {
  CABLE_CURVE_FLOATS, cablePolylineHitsAabb, flattenLinkCable, makeCableBox, makeCableSocketPick,
} from '../structures/cableCurve.js';
import { placementRejection } from '../structures/placementRules.js';
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
    const x0 = p.x - hw, y0 = p.y - hh, x1 = p.x + hw, y1 = p.y + hh;
    for (let e = 0; e < this.edges.length; e++) {
      const [ea, eb] = this.edges[e]!;
      const s = this.edgeSockets[e]!;
      flattenLinkCable(this.nodes.get(`s${ea}`)!, s[0], this.nodes.get(`s${eb}`)!, s[1], linkPoly, linkBox);
      if (linkBox.x1 < x0 || linkBox.x0 > x1 || linkBox.y1 < y0 || linkBox.y0 > y1) continue;
      if (cablePolylineHitsAabb(linkPoly, x0, y0, x1, y1)) return -1;
    }
    const i = this.placements.length;
    this.placements.push(p);
    this.placed.push({ x: p.x, y: p.y, radius: k.radius, halfW: hw, halfH: hh, kind: p.kind, rot });
    this.nodes.set(`s${i}`, {
      id: `s${i}`, kind: p.kind, x: p.x, y: p.y, rot: (rot * Math.PI) / 180, radius: k.radius, halfW: hw, halfH: hh,
      isHub: k.isHub, isCapital: p.kind === 'capital', isConnector: p.kind === 'connector',
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

  /** Remove the last placement (a leaf that couldn't be linked). */
  undoLast(): void {
    const i = this.placements.length - 1;
    this.placements.pop();
    this.placed.pop();
    this.nodes.delete(`s${i}`);
  }
}

const linkGaps = new Map<string, number>();
/** The smallest box gap (from `minGap`, in steps of 2) at which `kind`,
 *  turned `rot`, set square off a lone connector in direction (`dx`, `dy`),
 *  links it under the real `canConnect`: stud to stud at least
 *  `MIN_CABLE_LENGTH` ("keep buildings apart"). Studs square on to the
 *  connector need more gap than a kind whose nearest studs sit off-centre.
 *  Cached per kind, direction and turn (seed-time only). */
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
