/**
 * Per-tick broadphase for the projectile-vs-swarm sweep (ranges plan, risk 2).
 *
 * Before this, every live shell was tested against every swarm entity every
 * tick: O(shells × entities). Real-scale gun ranges put ~10× more shells in
 * flight, so `ProjectilePipeline` now rebuilds this grid once per tick and asks
 * it for the entities near each shell's step segment.
 *
 * Exactness: each entity is binned by a CONSERVATIVE axis-aligned box that
 * contains every shape the narrow phase can hit — the circle (`radius`, which
 * also gates a capital's hull refine), the footprint box (`halfW/halfH`) or the
 * union of its solid parts (`boxes`). A query covers the segment's box grown by
 * the shell radius (+ a 1 u guard). A narrow-phase hit needs a point of the
 * segment within the shell radius of the shape, so every entity that can be hit
 * is returned. Extra candidates (bucket collisions, corners) only cost a check.
 *
 * The pose is read from the SAB ONCE at build and the narrow phase uses that
 * copy, so the bin and the test agree even while the physics worker writes.
 *
 * Allocation-free in steady state (invariant #14): flat typed arrays, a fixed
 * hashed bucket table, generation stamps for de-duplication. The arrays grow
 * (doubling) only when the entity count passes the high-water mark.
 */

/** Cell edge (world units). A shell step is ~30–45 u at 60 Hz, so most
 *  queries touch one to four cells. */
export const BROADPHASE_CELL = 512;
/** Entities wider than this many cells on an axis skip the grid and are
 *  tested by every query (capitals, huge structures: a handful). */
const MAX_SPAN_CELLS = 4;
/** A query wider than this many cells on an axis scans all entities (with
 *  the box pre-test) instead of walking the grid. */
const MAX_QUERY_CELLS = 32;
const TABLE_BITS = 12;
const TABLE_SIZE = 1 << TABLE_BITS;
const TABLE_MASK = TABLE_SIZE - 1;
/** Guard band so float rounding at a box edge never drops a candidate. */
const GUARD = 1;

function bucketOf(cx: number, cy: number): number {
  return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & TABLE_MASK;
}

/** The record fields the bound needs. */
export interface BroadphaseShape {
  radius: number;
  halfW?: number;
  halfH?: number;
  boxes?: Float32Array;
}

export class ProjectileBroadphase<R extends BroadphaseShape> {
  /** Entity count of the current build; dense index = registry order. */
  count = 0;
  /** Records by dense index (valid below `count`). */
  readonly recs: R[] = [];
  /** Pose copied from the SAB at build, by dense index. */
  x = new Float64Array(64);
  y = new Float64Array(64);
  angle = new Float64Array(64);
  private minX = new Float64Array(64);
  private minY = new Float64Array(64);
  private maxX = new Float64Array(64);
  private maxY = new Float64Array(64);
  private stamp = new Int32Array(64);
  private gen = 0;

  private readonly head = new Int32Array(TABLE_SIZE);
  private next = new Int32Array(256);
  private entry = new Int32Array(256);
  private entries = 0;
  private wide = new Int32Array(16);
  private wideCount = 0;

  /** Candidate dense indices of the last query, ascending (registry order). */
  out = new Int32Array(64);
  outCount = 0;

  /** Start a build. */
  begin(): void {
    this.head.fill(-1);
    this.entries = 0;
    this.wideCount = 0;
    this.count = 0;
  }

  /** Add one entity at (cx, cy) with angle `ang`. Call in registry order. */
  add(rec: R, cx: number, cy: number, ang: number): void {
    const i = this.count++;
    if (i >= this.x.length) this.growEntities(i + 1);
    this.recs[i] = rec;
    this.x[i] = cx; this.y[i] = cy; this.angle[i] = ang;
    let ex = rec.radius, ey = rec.radius;
    if (rec.halfW !== undefined && rec.halfH !== undefined) {
      ex = Math.max(ex, rec.halfW); ey = Math.max(ey, rec.halfH);
      const b = rec.boxes;
      if (b) {
        for (let k = 0; k + 3 < b.length; k += 4) {
          const px = Math.abs(b[k]!) + b[k + 2]!;
          const py = Math.abs(b[k + 1]!) + b[k + 3]!;
          if (px > ex) ex = px;
          if (py > ey) ey = py;
        }
      }
    }
    const x0 = cx - ex, x1 = cx + ex, y0 = cy - ey, y1 = cy + ey;
    this.minX[i] = x0; this.maxX[i] = x1; this.minY[i] = y0; this.maxY[i] = y1;
    this.stamp[i] = 0;
    const c0 = Math.floor(x0 / BROADPHASE_CELL), c1 = Math.floor(x1 / BROADPHASE_CELL);
    const r0 = Math.floor(y0 / BROADPHASE_CELL), r1 = Math.floor(y1 / BROADPHASE_CELL);
    // A NaN pose (never expected) or a huge entity is tested by every query.
    if (!(c1 - c0 < MAX_SPAN_CELLS && r1 - r0 < MAX_SPAN_CELLS)) {
      if (this.wideCount >= this.wide.length) this.wide = grow(this.wide, this.wideCount + 1);
      this.wide[this.wideCount++] = i;
      return;
    }
    for (let cy2 = r0; cy2 <= r1; cy2++) {
      for (let cx2 = c0; cx2 <= c1; cx2++) {
        const e = this.entries++;
        if (e >= this.next.length) {
          this.next = grow(this.next, e + 1);
          this.entry = grow(this.entry, e + 1);
        }
        const h = bucketOf(cx2, cy2);
        this.entry[e] = i;
        this.next[e] = this.head[h]!;
        this.head[h] = e;
      }
    }
  }

  /** Finish a build: drop record refs past the new count. */
  end(): void {
    for (let i = this.count; i < this.recs.length && this.recs[i] !== undefined; i++) {
      (this.recs as Array<R | undefined>)[i] = undefined;
    }
  }

  /**
   * Fill `out[0..outCount)` with every entity whose bound overlaps the box of
   * the segment (fx, fy) → (fx + sx, fy + sy) grown by `pad`, in ascending
   * dense index (= registry order, so ties resolve as the full scan did).
   */
  query(fx: number, fy: number, sx: number, sy: number, pad: number): void {
    const p = pad + GUARD;
    const qx0 = Math.min(fx, fx + sx) - p, qx1 = Math.max(fx, fx + sx) + p;
    const qy0 = Math.min(fy, fy + sy) - p, qy1 = Math.max(fy, fy + sy) + p;
    if (++this.gen === 0x7fffffff) { this.stamp.fill(0); this.gen = 1; }
    const g = this.gen;
    this.outCount = 0;
    const c0 = Math.floor(qx0 / BROADPHASE_CELL), c1 = Math.floor(qx1 / BROADPHASE_CELL);
    const r0 = Math.floor(qy0 / BROADPHASE_CELL), r1 = Math.floor(qy1 / BROADPHASE_CELL);
    if (c1 - c0 < MAX_QUERY_CELLS && r1 - r0 < MAX_QUERY_CELLS) {
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          for (let e = this.head[bucketOf(cx, cy)]!; e !== -1; e = this.next[e]!) {
            this.consider(this.entry[e]!, g, qx0, qx1, qy0, qy1);
          }
        }
      }
      for (let k = 0; k < this.wideCount; k++) this.consider(this.wide[k]!, g, qx0, qx1, qy0, qy1);
      sortPrefix(this.out, this.outCount);
    } else {
      // Not a finite small box (huge step or NaN): scan everything, in order.
      for (let i = 0; i < this.count; i++) this.consider(i, g, qx0, qx1, qy0, qy1, true);
    }
  }

  private consider(i: number, g: number, qx0: number, qx1: number, qy0: number, qy1: number, scan = false): void {
    if (this.stamp[i] === g) return;
    this.stamp[i] = g;
    // `scan` keeps NaN boxes in (a comparison with NaN is false).
    if (!scan || !(Number.isNaN(qx0 + qx1 + qy0 + qy1))) {
      if (this.maxX[i]! < qx0 || this.minX[i]! > qx1 || this.maxY[i]! < qy0 || this.minY[i]! > qy1) return;
    }
    if (this.outCount >= this.out.length) this.out = grow(this.out, this.outCount + 1);
    this.out[this.outCount++] = i;
  }

  private growEntities(n: number): void {
    this.x = growF(this.x, n); this.y = growF(this.y, n); this.angle = growF(this.angle, n);
    this.minX = growF(this.minX, n); this.minY = growF(this.minY, n);
    this.maxX = growF(this.maxX, n); this.maxY = growF(this.maxY, n);
    this.stamp = grow(this.stamp, n);
  }
}

function grow(a: Int32Array<ArrayBuffer>, need: number): Int32Array<ArrayBuffer> {
  let n = a.length * 2;
  while (n < need) n *= 2;
  const b = new Int32Array(n);
  b.set(a);
  return b;
}

function growF(a: Float64Array<ArrayBuffer>, need: number): Float64Array<ArrayBuffer> {
  let n = a.length * 2;
  while (n < need) n *= 2;
  const b = new Float64Array(n);
  b.set(a);
  return b;
}

/** In-place insertion sort of a[0..n): candidate lists are short. */
function sortPrefix(a: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const v = a[i]!;
    let j = i - 1;
    while (j >= 0 && a[j]! > v) { a[j + 1] = a[j]!; j--; }
    a[j + 1] = v;
  }
}
