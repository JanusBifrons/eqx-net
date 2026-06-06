/**
 * Server-side registry of placed structures (speed-dial-resource-structures
 * plan, Phase 2). Owns the per-structure bookkeeping the swarm registry does
 * NOT carry: ownership, the structure subtype, and construction state.
 *
 * Session-scoped per `SectorRoom` (persistence is a noted follow-up). Phase 3
 * extends this with the connection adjacency map for the power grid; Phase 2
 * keeps it to the flat record table.
 */
import type { StructureKindId } from '../../shared-types/structureKinds.js';

export interface StructureRecord {
  /** Swarm entity id (also the binary-wire id). */
  id: string;
  /** Owning playerId. */
  owner: string;
  /** Structure subtype. */
  kind: StructureKindId;
  /** Index into `STRUCTURE_KINDS_LIST` (the wire subtype byte). */
  subtypeIndex: number;
  /** World pose (structures are static — set once at placement). */
  x: number;
  y: number;
  /** Collider + sprite radius (from the kind catalogue). */
  radius: number;
  /** False while a blueprint; flips true when the grid finishes building it
   *  (Phase 3). The Capital is born `true` (pre-built). */
  isConstructed: boolean;
  /** Minerals delivered so far (0..constructionCost). */
  constructionProgress: number;
  /** Total minerals to fully build. 0 for the pre-built Capital. */
  constructionCost: number;
  /** True while the player is reclaiming this structure (Phase 3). */
  isDeconstructing: boolean;
}

export class StructureRegistry {
  private readonly byId = new Map<string, StructureRecord>();

  add(rec: StructureRecord): void {
    this.byId.set(rec.id, rec);
  }

  get(id: string): StructureRecord | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  remove(id: string): StructureRecord | undefined {
    const rec = this.byId.get(id);
    if (rec) this.byId.delete(id);
    return rec;
  }

  all(): IterableIterator<StructureRecord> {
    return this.byId.values();
  }

  get size(): number {
    return this.byId.size;
  }
}
