/**
 * Pre-allocated circular buffer storing per-entity positions for lag compensation.
 *
 * Layout: RING_CAPACITY entity slots × RING_DEPTH tick slots × 4 floats (x, y, vx, vy).
 * Total: 1000 × 12 × 16 bytes = 192 KB per sector — no per-tick heap allocation.
 *
 * Entity IDs are mapped to integer slot indices via a simple Map. Slot indices are
 * stable for the lifetime of the entity and freed on despawn.
 */

const RING_CAPACITY = 1000;
const RING_DEPTH = 12;
const FLOATS_PER_ENTRY = 4; // x, y, vx, vy

export class SnapshotRing {
  /** Main data buffer: [entity slot][tick ring slot][x, y, vx, vy] */
  private readonly buf: Float32Array;
  /** Which absolute tick is stored at each ring slot (per entity). Shared across entities. */
  private readonly tickAt: Int32Array;
  /** Maps entity ID → entity slot index in buf. */
  private readonly entityToSlot = new Map<string, number>();
  /** Free entity slot pool. */
  private readonly freeEntitySlots: number[] = [];

  constructor() {
    this.buf = new Float32Array(RING_CAPACITY * RING_DEPTH * FLOATS_PER_ENTRY);
    this.tickAt = new Int32Array(RING_DEPTH).fill(-1);
    for (let i = RING_CAPACITY - 1; i >= 0; i--) this.freeEntitySlots.push(i);
  }

  /** Total buffer size in bytes — used by tests to verify the 192 KB guarantee. */
  get byteLength(): number {
    return this.buf.byteLength;
  }

  /** Register a new entity (allocates a slot). Called when a ship joins. */
  registerEntity(id: string): void {
    if (this.entityToSlot.has(id)) return;
    const slot = this.freeEntitySlots.pop();
    if (slot === undefined) return; // ring at capacity, silently ignore
    this.entityToSlot.set(id, slot);
  }

  /** Release a slot. Called when a ship leaves. */
  unregisterEntity(id: string): void {
    const slot = this.entityToSlot.get(id);
    if (slot === undefined) return;
    this.entityToSlot.delete(id);
    this.freeEntitySlots.push(slot);
  }

  /**
   * Record positions for the current tick.
   * Called once per server tick from SectorRoom.update().
   */
  record(
    tick: number,
    entities: Iterable<{ id: string; x: number; y: number; vx: number; vy: number }>,
  ): void {
    const ringSlot = tick % RING_DEPTH;
    this.tickAt[ringSlot] = tick;

    for (const { id, x, y, vx, vy } of entities) {
      const entitySlot = this.entityToSlot.get(id);
      if (entitySlot === undefined) continue;
      const base = (entitySlot * RING_DEPTH + ringSlot) * FLOATS_PER_ENTRY;
      this.buf[base]     = x;
      this.buf[base + 1] = y;
      this.buf[base + 2] = vx;
      this.buf[base + 3] = vy;
    }
  }

  /**
   * Retrieve an entity's position at a specific tick.
   * Returns null when the tick is outside the RING_DEPTH window or the entity is unknown.
   */
  getAt(entityId: string, tick: number): { x: number; y: number } | null {
    const entitySlot = this.entityToSlot.get(entityId);
    if (entitySlot === undefined) return null;
    const ringSlot = tick % RING_DEPTH;
    if (this.tickAt[ringSlot] !== tick) return null;
    const base = (entitySlot * RING_DEPTH + ringSlot) * FLOATS_PER_ENTRY;
    return { x: this.buf[base]!, y: this.buf[base + 1]! };
  }
}
