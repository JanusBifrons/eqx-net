/**
 * Coarse spatial hash for per-client swarm interest filtering.
 *
 * The world is partitioned into 2048-unit cells. Each entity sits in exactly
 * one cell, looked up by its (x, y). `query9(cx, cy)` returns the entities in
 * the 3×3 cell window centred on (cx, cy) — the per-client "in-interest" set
 * the binary swarm broadcast uses to decide which entities to ship at full
 * fidelity vs decimate.
 *
 * Cell index is packed into a single i32: `(floor(x/CELL) << 16) | (floor(y/CELL) & 0xffff)`
 * Both axes are clamped to ±32_000 units in `insert()` to keep cell indices
 * inside int16 range (the soft 100_000-unit world clamp from the master plan
 * is deferred to Phase 6; the assertion here is defensive).
 *
 * No allocation in the per-tick hot path: `move()` returns early when the
 * entity hasn't crossed a cell boundary, and `query9()` writes its result
 * into a caller-provided `Set<number>` rather than allocating a fresh one.
 */
export const CELL_SIZE = 2048;
const COORD_LIMIT = 32_000;

/** Pack a cell coordinate pair into a single i32 key. */
function cellKey(cx: number, cy: number): number {
  return ((cx & 0xffff) << 16) | (cy & 0xffff);
}

function coordToCell(coord: number): number {
  return Math.floor(coord / CELL_SIZE);
}

/**
 * Per-client subscription window with hysteresis. The 3×3 window centred on
 * the client's current cell flips to the new window only after the client
 * has crossed past the half-cell boundary of its current centre — without
 * this, an entity straddling the boundary would flap in/out of interest
 * each frame.
 */
export const HYSTERESIS_FRACTION = 0.5;

export interface SpatialGridStats {
  entityCount: number;
  cellCount: number;
  maxCellPopulation: number;
}

export class SpatialGrid {
  /** entityId → packed cell key (for cheap "did the cell change?" detection in move). */
  private readonly entityCell = new Map<number, number>();
  /** packed cell key → set of entityIds in that cell. */
  private readonly cellMembers = new Map<number, Set<number>>();

  insert(entityId: number, x: number, y: number): void {
    if (Math.abs(x) > COORD_LIMIT || Math.abs(y) > COORD_LIMIT) {
      // Clamp into bounds rather than throw: an out-of-bounds entity would be
      // a worse failure mode than a slightly-misplaced one. Phase 6's soft
      // 100k-unit world clamp will prevent this entirely.
      x = Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, x));
      y = Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, y));
    }
    const key = cellKey(coordToCell(x), coordToCell(y));
    this.entityCell.set(entityId, key);
    let bucket = this.cellMembers.get(key);
    if (!bucket) {
      bucket = new Set<number>();
      this.cellMembers.set(key, bucket);
    }
    bucket.add(entityId);
  }

  /**
   * Update the entity's cell. Cheap when the entity stays in the same cell
   * (most ticks, since CELL_SIZE >> per-tick velocity).
   */
  move(entityId: number, x: number, y: number): void {
    const newKey = cellKey(coordToCell(x), coordToCell(y));
    const oldKey = this.entityCell.get(entityId);
    if (oldKey === newKey) return;
    if (oldKey !== undefined) {
      const oldBucket = this.cellMembers.get(oldKey);
      if (oldBucket) {
        oldBucket.delete(entityId);
        if (oldBucket.size === 0) this.cellMembers.delete(oldKey);
      }
    }
    this.entityCell.set(entityId, newKey);
    let newBucket = this.cellMembers.get(newKey);
    if (!newBucket) {
      newBucket = new Set<number>();
      this.cellMembers.set(newKey, newBucket);
    }
    newBucket.add(entityId);
  }

  remove(entityId: number): void {
    const key = this.entityCell.get(entityId);
    if (key === undefined) return;
    this.entityCell.delete(entityId);
    const bucket = this.cellMembers.get(key);
    if (bucket) {
      bucket.delete(entityId);
      if (bucket.size === 0) this.cellMembers.delete(key);
    }
  }

  /**
   * Populate `out` with every entity in the 3×3 cell window around (cx, cy).
   * Mutates and returns `out` so the caller can re-use a scratch set across
   * ticks without allocating.
   */
  query9(cx: number, cy: number, out: Set<number>): Set<number> {
    out.clear();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.cellMembers.get(cellKey(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const id of bucket) out.add(id);
      }
    }
    return out;
  }

  /** Cell coordinates the world point (x, y) falls into. */
  cellOf(x: number, y: number): { cx: number; cy: number } {
    return { cx: coordToCell(x), cy: coordToCell(y) };
  }

  size(): number {
    return this.entityCell.size;
  }

  stats(): SpatialGridStats {
    let maxPop = 0;
    for (const bucket of this.cellMembers.values()) {
      if (bucket.size > maxPop) maxPop = bucket.size;
    }
    return { entityCount: this.entityCell.size, cellCount: this.cellMembers.size, maxCellPopulation: maxPop };
  }
}
