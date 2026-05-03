/**
 * Authoritative registry for swarm entities. Maps a stable string id (used by
 * AI / bus events / snapshot ring) to a dense `u16 entityId` (used on the
 * wire) and to a SAB slot (used for physics state). Holds the last-broadcast
 * pose per entity so the encoder can produce delta packets without scanning
 * Rapier on its own.
 *
 * Entity IDs are dense 0..65535 to keep the binary packet stride minimal.
 * Slots are 0..MAX_ENTITIES-1, allocated by the SectorRoom slot pool.
 */

export type SwarmKind = 0 /* asteroid */ | 1 /* drone */;

export interface SwarmEntityRecord {
  id: string;
  entityId: number;
  slot: number;
  kind: SwarmKind;
  /** Collision radius — shipped on the wire and used by the server hitscan path. */
  radius: number;
  /** Last pose actually included in a swarm packet, for delta detection. */
  lastBroadcast: { x: number; y: number; angle: number };
  /** Last sleeping flag included in a swarm packet, for transition detection. */
  lastBroadcastSleeping: boolean;
  /** Tick when this entity was last shipped in a packet. Used by sweepers later. */
  lastBroadcastTick: number;
}

const QUANT_POS = 0.05;   // 5 cm
const QUANT_ANGLE = 0.005; // ~0.3°

export class SwarmEntityRegistry {
  private readonly byId = new Map<string, SwarmEntityRecord>();
  private readonly byEntityId = new Map<number, SwarmEntityRecord>();
  private readonly freeEntityIds: number[] = [];
  private nextEntityId = 0;

  /** Allocate a fresh dense entityId. Reuses freed ones first. */
  private allocEntityId(): number {
    const reused = this.freeEntityIds.pop();
    if (reused !== undefined) return reused;
    if (this.nextEntityId >= 65535) {
      throw new Error('SwarmEntityRegistry: exhausted u16 entity id space');
    }
    return this.nextEntityId++;
  }

  register(id: string, slot: number, kind: SwarmKind, radius: number, x: number, y: number, angle: number): SwarmEntityRecord {
    if (this.byId.has(id)) {
      throw new Error(`SwarmEntityRegistry: id "${id}" already registered`);
    }
    const entityId = this.allocEntityId();
    const record: SwarmEntityRecord = {
      id,
      entityId,
      slot,
      kind,
      radius,
      lastBroadcast: { x, y, angle },
      lastBroadcastSleeping: false,
      lastBroadcastTick: -1,
    };
    this.byId.set(id, record);
    this.byEntityId.set(entityId, record);
    return record;
  }

  unregister(id: string): SwarmEntityRecord | null {
    const rec = this.byId.get(id);
    if (!rec) return null;
    this.byId.delete(id);
    this.byEntityId.delete(rec.entityId);
    this.freeEntityIds.push(rec.entityId);
    return rec;
  }

  get(id: string): SwarmEntityRecord | null {
    return this.byId.get(id) ?? null;
  }

  getByEntityId(entityId: number): SwarmEntityRecord | null {
    return this.byEntityId.get(entityId) ?? null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  size(): number {
    return this.byId.size;
  }

  /** Iterate all registered records in registration order. */
  *all(): IterableIterator<SwarmEntityRecord> {
    for (const rec of this.byId.values()) yield rec;
  }

  /** Returns true if (x,y,angle) differs from `lastBroadcast` by more than the quantisation epsilons. */
  static poseChanged(rec: SwarmEntityRecord, x: number, y: number, angle: number): boolean {
    return (
      Math.abs(rec.lastBroadcast.x - x) >= QUANT_POS ||
      Math.abs(rec.lastBroadcast.y - y) >= QUANT_POS ||
      Math.abs(rec.lastBroadcast.angle - angle) >= QUANT_ANGLE
    );
  }
}
