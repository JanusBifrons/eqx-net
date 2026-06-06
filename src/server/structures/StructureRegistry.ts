/**
 * Server-side registry of placed structures (speed-dial-resource-structures
 * plan, Phase 2 + 3). Owns the per-structure bookkeeping the swarm registry does
 * NOT carry: ownership, the structure subtype, construction state, the stored
 * mineral pool, and (Phase 3) the connection adjacency map for the power grid.
 *
 * Session-scoped per `SectorRoom` (persistence is a noted follow-up).
 */
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import { Connection } from '../../core/structures/Connection.js';

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
  /** False while a blueprint; flips true when the grid finishes building it.
   *  The Capital is born `true` (pre-built). */
  isConstructed: boolean;
  /** Minerals delivered so far (0..constructionCost). */
  constructionProgress: number;
  /** Total minerals to fully build. 0 for the pre-built Capital. */
  constructionCost: number;
  /** True while the player is reclaiming this structure (Phase 3 deconstruct). */
  isDeconstructing: boolean;
  /** Minerals currently stored here. Only the Capital has meaningful
   *  `storageCapacity`; it is the bank the construction stream draws from.
   *  A Miner buffers locally here before hauling toward the Capital. */
  minerals: number;
  /** Phase 4 — the asteroid entityId this Miner is currently extracting from
   *  (for the client beam). Transient; recomputed each pulse, undefined when
   *  not a miner / unpowered / no asteroid in range. */
  miningTargetEntityId?: number;
}

export class StructureRegistry {
  private readonly byId = new Map<string, StructureRecord>();
  /** Adjacency: structureId → its connections (each appears in BOTH endpoints'
   *  lists). O(1) neighbour lookup for BFS/A*. */
  private readonly adjacency = new Map<string, Connection[]>();
  /** Flat connectionId → Connection (for the wire + flash lookups). */
  private readonly connById = new Map<number, Connection>();
  private connCounter = 0;
  /** Set whenever topology changes (add/sever/construct); the grid subsystem
   *  rebuilds components + drops the route cache only when this is true. */
  topologyDirty = true;

  add(rec: StructureRecord): void {
    this.byId.set(rec.id, rec);
    this.topologyDirty = true;
  }

  get(id: string): StructureRecord | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Remove a structure AND sever every connection touching it (no leaks).
   *  Returns the removed record (or undefined). */
  remove(id: string): StructureRecord | undefined {
    this.disconnect(id);
    const rec = this.byId.get(id);
    if (rec) {
      this.byId.delete(id);
      this.topologyDirty = true;
    }
    return rec;
  }

  all(): IterableIterator<StructureRecord> {
    return this.byId.values();
  }

  get size(): number {
    return this.byId.size;
  }

  // ── Connections (Phase 3) ────────────────────────────────────────────────

  /** Connections touching `id` (empty array if none). */
  connectionsOf(id: string): readonly Connection[] {
    return this.adjacency.get(id) ?? [];
  }

  connectionCount(id: string): number {
    return this.adjacency.get(id)?.length ?? 0;
  }

  hasConnection(aId: string, bId: string): boolean {
    return (this.adjacency.get(aId) ?? []).some((c) => c.getOtherNode(aId) === bId);
  }

  /** The full adjacency view (read-only) for `canConnect` / grid rebuild. */
  adjacencyMap(): ReadonlyMap<string, readonly Connection[]> {
    return this.adjacency;
  }

  allConnections(): IterableIterator<Connection> {
    return this.connById.values();
  }

  getConnection(id: number): Connection | undefined {
    return this.connById.get(id);
  }

  /** Create + register a connection between two structures. */
  addConnection(aId: string, bId: string, throughput: number): Connection {
    const c = new Connection(this.connCounter++, aId, bId, throughput);
    let aList = this.adjacency.get(aId);
    if (!aList) { aList = []; this.adjacency.set(aId, aList); }
    aList.push(c);
    let bList = this.adjacency.get(bId);
    if (!bList) { bList = []; this.adjacency.set(bId, bList); }
    bList.push(c);
    this.connById.set(c.id, c);
    this.topologyDirty = true;
    return c;
  }

  /** Sever every connection touching `id`. Returns the severed connection ids. */
  disconnect(id: string): number[] {
    const conns = this.adjacency.get(id);
    if (!conns || conns.length === 0) return [];
    const severed: number[] = [];
    for (const c of conns) {
      severed.push(c.id);
      this.connById.delete(c.id);
      const other = c.getOtherNode(id);
      if (other !== null) {
        const otherList = this.adjacency.get(other);
        if (otherList) {
          const i = otherList.indexOf(c);
          if (i >= 0) otherList.splice(i, 1);
        }
      }
    }
    this.adjacency.delete(id);
    this.topologyDirty = true;
    return severed;
  }
}
