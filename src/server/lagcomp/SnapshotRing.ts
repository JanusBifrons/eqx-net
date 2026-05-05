/**
 * Pre-allocated circular buffer storing per-entity poses for lag compensation.
 *
 * Layout: RING_CAPACITY entity slots × RING_DEPTH tick slots × 5 floats
 * (x, y, vx, vy, angle). Capacity bumped to 2048 to cover ships + every
 * dynamic swarm entity (asteroids + drones), so polygon-aware hit resolution
 * can rewind any obstacle's pose to the shooter's tick. 2048 × 12 × 20 bytes
 * = 480 KB per sector — no per-tick heap allocation.
 *
 * The recording API is split into `beginTick` + `recordEntity` to keep the
 * hot path allocation-free at scale (thousands of entities × 60 Hz). The
 * single-call `record(tick, iterable)` method is retained as a convenience
 * for unit tests; production code in SectorRoom.update() uses the streaming
 * form.
 */

const RING_CAPACITY = 2048;
const RING_DEPTH = 12;
const FLOATS_PER_ENTRY = 5; // x, y, vx, vy, angle

export interface RingEntity {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

export interface RingPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

export class SnapshotRing {
  /** Main data buffer: [entity slot][tick ring slot][x, y, vx, vy, angle] */
  private readonly buf: Float32Array;
  /** Which absolute tick is stored at each ring slot. Shared across entities. */
  private readonly tickAt: Int32Array;
  /** Maps entity ID → entity slot index in buf. */
  private readonly entityToSlot = new Map<string, number>();
  /** Free entity slot pool. */
  private readonly freeEntitySlots: number[] = [];
  /** Tick currently being written to (set by beginTick, read by recordEntity). */
  private currentTick: number = -1;
  private currentRingSlot: number = -1;

  constructor() {
    this.buf = new Float32Array(RING_CAPACITY * RING_DEPTH * FLOATS_PER_ENTRY);
    this.tickAt = new Int32Array(RING_DEPTH).fill(-1);
    for (let i = RING_CAPACITY - 1; i >= 0; i--) this.freeEntitySlots.push(i);
  }

  /** Total buffer size in bytes — used by tests to verify the alloc guarantee. */
  get byteLength(): number {
    return this.buf.byteLength;
  }

  /** Capacity (entity slots). Exposed for tests + assertions. */
  get capacity(): number {
    return RING_CAPACITY;
  }

  /** Register a new entity (allocates a slot). Called when a ship joins or a
   *  swarm entity spawns. Silent no-op when the ring is at capacity. */
  registerEntity(id: string): void {
    if (this.entityToSlot.has(id)) return;
    const slot = this.freeEntitySlots.pop();
    if (slot === undefined) return; // ring at capacity, silently ignore
    this.entityToSlot.set(id, slot);
  }

  /** Release a slot. Called when a ship leaves or a swarm entity despawns. */
  unregisterEntity(id: string): void {
    const slot = this.entityToSlot.get(id);
    if (slot === undefined) return;
    this.entityToSlot.delete(id);
    this.freeEntitySlots.push(slot);
  }

  /**
   * Begin recording a tick. Call this once per `update()` before the
   * `recordEntity` loop. Marks the ring slot for `tick` so that the wrap-around
   * write invalidates any stale entry from `tick - RING_DEPTH`.
   */
  beginTick(tick: number): void {
    this.currentTick = tick;
    this.currentRingSlot = ((tick % RING_DEPTH) + RING_DEPTH) % RING_DEPTH;
    this.tickAt[this.currentRingSlot] = tick;
  }

  /**
   * Record one entity's pose for the tick previously declared with `beginTick`.
   * Called once per entity per tick. Allocation-free — writes directly into
   * the pre-allocated buffer. Unknown entities are silently ignored (the
   * caller hasn't registered them, so they never participate in lag-comp).
   */
  recordEntity(id: string, x: number, y: number, vx: number, vy: number, angle: number): void {
    const entitySlot = this.entityToSlot.get(id);
    if (entitySlot === undefined) return;
    if (this.currentRingSlot < 0) return; // beginTick not yet called
    const base = (entitySlot * RING_DEPTH + this.currentRingSlot) * FLOATS_PER_ENTRY;
    this.buf[base]     = x;
    this.buf[base + 1] = y;
    this.buf[base + 2] = vx;
    this.buf[base + 3] = vy;
    this.buf[base + 4] = angle;
  }

  /**
   * Convenience batch API used by unit tests. Not used on the hot path —
   * production code uses `beginTick` + `recordEntity` to avoid materializing
   * the iterable.
   */
  record(tick: number, entities: Iterable<RingEntity>): void {
    this.beginTick(tick);
    for (const e of entities) {
      this.recordEntity(e.id, e.x, e.y, e.vx, e.vy, e.angle);
    }
  }

  /**
   * Retrieve an entity's full pose at a specific tick. Returns null when the
   * tick is outside the RING_DEPTH window or the entity is unknown.
   */
  getPoseAt(id: string, tick: number): RingPose | null {
    const entitySlot = this.entityToSlot.get(id);
    if (entitySlot === undefined) return null;
    const ringSlot = ((tick % RING_DEPTH) + RING_DEPTH) % RING_DEPTH;
    if (this.tickAt[ringSlot] !== tick) return null;
    const base = (entitySlot * RING_DEPTH + ringSlot) * FLOATS_PER_ENTRY;
    return {
      x: this.buf[base]!,
      y: this.buf[base + 1]!,
      vx: this.buf[base + 2]!,
      vy: this.buf[base + 3]!,
      angle: this.buf[base + 4]!,
    };
  }
}
