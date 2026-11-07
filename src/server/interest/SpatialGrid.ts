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
 * Both axes are clamped to the packed int16 cell range (±32,767 cells, about
 * ±67 million units) so a cell index never wraps. Solar-system sectors
 * (plan prancy-squishing-donut Phase 4) span ±200,000 u: the old ±32,000
 * clamp put everything beyond it into one edge cell.
 *
 * No allocation in the per-tick hot path: `move()` returns early when the
 * entity hasn't crossed a cell boundary, and `query9()` writes its result
 * into a caller-provided `Set<number>` rather than allocating a fresh one.
 */
export const CELL_SIZE = 2048;
/** Largest |coordinate| with its own cell: the packed int16 cell range. */
export const SPATIAL_COORD_LIMIT = 32_767 * CELL_SIZE - 1;


/** Pack a cell coordinate pair into a single i32 key. */
function cellKey(cx: number, cy: number): number {
  return ((cx & 0xffff) << 16) | (cy & 0xffff);
}

/** Cell of a coordinate, clamped into the packed range (never wraps). */
function coordToCell(coord: number): number {
  const c = coord > SPATIAL_COORD_LIMIT ? SPATIAL_COORD_LIMIT : coord < -SPATIAL_COORD_LIMIT ? -SPATIAL_COORD_LIMIT : coord;
  return Math.floor(c / CELL_SIZE);
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
  /** Entities wider than a cell (capital ships, round 3): entityId → reach in
   *  cells. A 5.8 km hull whose centre is two cells away still has its bow in
   *  your window, so `query9` includes it when its reach overlaps the window. */
  private readonly wideReach = new Map<number, number>();
  private qcx = 0;
  private qcy = 0;
  private qreach = 1;
  private qout: Set<number> | null = null;
  private readonly addIfWideInWindow = (reach: number, id: number): void => {
    const key = this.entityCell.get(id);
    if (key === undefined) return;
    const ecx = (key >> 16), ecy = (key << 16) >> 16;
    if (Math.max(Math.abs(ecx - this.qcx), Math.abs(ecy - this.qcy)) <= this.qreach + reach) this.qout!.add(id);
  };

  /** Window reach (in cells) for a viewer whose ship has this radius: 1 for
   *  anything up to half a cell, growing with the hull for capitals. */
  static viewerReachFor(radius: number): number {
    return 1 + (radius > CELL_SIZE / 2 ? Math.ceil(radius / CELL_SIZE) : 0);
  }

  /** Mark an entity as wider than a cell (`radius` in world units); 0 clears. */
  setWide(entityId: number, radius: number): void {
    const reach = Math.ceil(radius / CELL_SIZE);
    if (radius > CELL_SIZE / 2) this.wideReach.set(entityId, reach); else this.wideReach.delete(entityId);
  }

  /** `radius` marks an entity wider than a cell (see `setWide`). Pass it at
   *  spawn: `move` only marks an entity on its FIRST sighting, so one inserted
   *  here without a radius was never wide (capitals Phase 3 bug). */
  insert(entityId: number, x: number, y: number, radius = 0): void {
    if (radius > 0) this.setWide(entityId, radius);
    // Clamped into the packed cell range rather than thrown: an entity off
    // the edge is better slightly misplaced than corrupting a cell index.
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
  /** `radius` (optional) marks a newly seen entity wider than a cell (see `setWide`). */
  move(entityId: number, x: number, y: number, radius = 0): void {
    const newKey = cellKey(coordToCell(x), coordToCell(y));
    const oldKey = this.entityCell.get(entityId);
    if (oldKey === newKey) return;
    if (oldKey === undefined && radius > 0) this.setWide(entityId, radius);
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
    this.wideReach.delete(entityId);
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
   * Populate `out` with every entity in the 3×3 cell window around (cx, cy),
   * plus any wide entity whose reach overlaps it. `viewerReach` (default 1)
   * grows the window for a viewer flying a big ship: a capital pilot sees
   * what their camera shows. Mutates and returns `out` (no allocation).
   */
  query9(cx: number, cy: number, out: Set<number>, viewerReach = 1): Set<number> {
    out.clear();
    for (let dy = -viewerReach; dy <= viewerReach; dy++) {
      for (let dx = -viewerReach; dx <= viewerReach; dx++) {
        const bucket = this.cellMembers.get(cellKey(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const id of bucket) out.add(id);
      }
    }
    if (this.wideReach.size > 0) {
      this.qcx = cx; this.qcy = cy; this.qreach = viewerReach; this.qout = out;
      this.wideReach.forEach(this.addIfWideInWindow);
      this.qout = null;
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
