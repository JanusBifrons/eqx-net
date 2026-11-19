/** The base generator's placement checker (`growBase.ts`, step 2: "Lay
 *  out"): every placement passes the real `placementRejection` and every
 *  edge the real `canConnect`, AS the base is built. */
import { getStructureKind, structureHalfExtents, type StructureKindId } from '../../shared-types/structureKinds.js';
import { canConnect, segmentIntersectsAabb, type GridNode } from '../structures/Grid.js';
import { Connection } from '../structures/Connection.js';
import { placementRejection } from '../structures/placementRules.js';
import { isShieldEmitterKind } from '../structures/gateGeometry.js';
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

export class Builder {
  readonly placements: GrownPlacement[] = [];
  readonly edges: Array<readonly [number, number]> = [];
  readonly placed: Array<{ x: number; y: number; radius: number; halfW: number; halfH: number; kind: StructureKindId; rot: number }> = [];
  readonly nodes = new Map<string, Node>();
  readonly adj = new Map<string, Connection[]>();
  private cid = 0;

  /** Place if the real overlap rule allows; returns the index or -1. */
  tryPlace(p: GrownPlacement): number {
    const rot = p.rot ?? 0;
    if (placementRejection(p.kind, p.x, p.y, this.placed, null, rot) !== null) return -1;
    const k = getStructureKind(p.kind);
    const { hw, hh } = structureHalfExtents(p.kind, rot);
    // Never on top of an existing link (a link needs a clear line of sight).
    for (const [ea, eb] of this.edges) {
      const a = this.placements[ea]!, b = this.placements[eb]!;
      if (segmentIntersectsAabb(a.x, a.y, b.x, b.y, p.x - hw, p.y - hh, p.x + hw, p.y + hh)) return -1;
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
    const r = canConnect(na, nb, this.adj, this.nodes);
    if (!r.ok) return false;
    const c = new Connection(this.cid++, na.id, nb.id, 1);
    (this.adj.get(na.id) ?? this.adj.set(na.id, []).get(na.id)!).push(c);
    (this.adj.get(nb.id) ?? this.adj.set(nb.id, []).get(nb.id)!).push(c);
    this.edges.push([a, b]);
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
