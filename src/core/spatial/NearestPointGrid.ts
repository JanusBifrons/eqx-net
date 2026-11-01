/**
 * NearestPointGrid — a uniform bucket grid for "nearest point within range"
 * queries (plan soft-leaping-truffle v2, A1). Built once per use-window
 * (e.g. once per turret tick) in O(P), queried in O(points in the cells the
 * range covers) instead of O(all points).
 *
 * SEMANTICS match the linear scan it replaces exactly: a point qualifies when
 * its squared distance ≤ range²; the smallest squared distance wins; on an
 * exact tie the point ADDED LATEST wins (the linear scan's `d2 <= best`
 * keeps the last equal). Callers add points in their scan order.
 *
 * Allocation-free in steady state (invariant #14): typed arrays grow by
 * doubling only when a build exceeds capacity; `reset`/`add`/`build`/`nearest`
 * allocate nothing otherwise. Points outside the extent are clamped into the
 * edge cells (their true position is still used for distance), so nothing is
 * ever dropped.
 */
export class NearestPointGrid {
  private readonly cols: number;
  private readonly cellCount: number;
  private readonly inv: number;
  private readonly half: number;
  private xs: Float64Array;
  private ys: Float64Array;
  private cellOf: Int32Array;
  /** Prefix-summed cell starts (counting sort): points of cell c are
   *  `order[start[c] .. start[c+1])`. */
  private readonly start: Int32Array;
  private order: Int32Array;
  private n = 0;
  /** Points examined by the last `nearest` call (op-count lock; no alloc). */
  lastVisited = 0;

  /**
   * @param cellSize  bucket edge (world units)
   * @param halfExtent  the grid covers [-halfExtent, +halfExtent]² (outside is clamped)
   * @param initialCapacity  starting point capacity (grows by doubling)
   */
  constructor(cellSize: number, halfExtent: number, initialCapacity = 256) {
    this.half = halfExtent;
    this.inv = 1 / cellSize;
    this.cols = Math.max(1, Math.ceil((2 * halfExtent) / cellSize));
    this.cellCount = this.cols * this.cols;
    this.start = new Int32Array(this.cellCount + 1);
    this.xs = new Float64Array(initialCapacity);
    this.ys = new Float64Array(initialCapacity);
    this.cellOf = new Int32Array(initialCapacity);
    this.order = new Int32Array(initialCapacity);
  }

  get size(): number {
    return this.n;
  }

  reset(): void {
    this.n = 0;
  }

  private col(v: number): number {
    const c = Math.floor((v + this.half) * this.inv);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  /** Add a point; returns its index (0, 1, 2… in add order). */
  add(x: number, y: number): number {
    if (this.n === this.xs.length) this.grow();
    const i = this.n++;
    this.xs[i] = x;
    this.ys[i] = y;
    this.cellOf[i] = this.col(y) * this.cols + this.col(x);
    return i;
  }

  private grow(): void {
    const cap = this.xs.length * 2;
    const xs = new Float64Array(cap); xs.set(this.xs); this.xs = xs;
    const ys = new Float64Array(cap); ys.set(this.ys); this.ys = ys;
    const co = new Int32Array(cap); co.set(this.cellOf); this.cellOf = co;
    this.order = new Int32Array(cap);
  }

  /** Bucket the added points (counting sort). Call after the last `add`. */
  build(): void {
    const start = this.start;
    start.fill(0);
    for (let i = 0; i < this.n; i++) start[this.cellOf[i]! + 1]!++;
    for (let c = 0; c < this.cellCount; c++) start[c + 1]! += start[c]!;
    // Place in add order within each cell (stable), using start[] as a cursor
    // then restoring it.
    for (let i = 0; i < this.n; i++) {
      const c = this.cellOf[i]!;
      this.order[start[c]!++] = i;
    }
    for (let c = this.cellCount; c > 0; c--) start[c] = start[c - 1]!;
    start[0] = 0;
  }

  /** Index of the nearest point within `range` of (x, y), or -1. */
  nearest(x: number, y: number, range: number): number {
    if (this.n === 0 || !(range >= 0)) return -1;
    const c0 = this.col(x - range), c1 = this.col(x + range);
    const r0 = this.col(y - range), r1 = this.col(y + range);
    let best = -1;
    let bestD2 = range * range;
    let visited = 0;
    for (let r = r0; r <= r1; r++) {
      const rowBase = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        const cell = rowBase + c;
        const end = this.start[cell + 1]!;
        visited += end - this.start[cell]!;
        for (let k = this.start[cell]!; k < end; k++) {
          const i = this.order[k]!;
          const dx = this.xs[i]! - x;
          const dy = this.ys[i]! - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2 || (d2 === bestD2 && i > best)) {
            bestD2 = d2;
            best = i;
          }
        }
      }
    }
    this.lastVisited = visited;
    return best;
  }

  /**
   * Like `nearest`, but only points for which `accept(i)` is true count
   * (B2: NPC turrets keep only targets hostile to their owner). Pass a
   * pre-bound function so the query allocates nothing. Same tie rule.
   */
  nearestWhere(x: number, y: number, range: number, accept: (i: number) => boolean): number {
    if (this.n === 0 || !(range >= 0)) return -1;
    const c0 = this.col(x - range), c1 = this.col(x + range);
    const r0 = this.col(y - range), r1 = this.col(y + range);
    let best = -1;
    let bestD2 = range * range;
    let visited = 0;
    for (let r = r0; r <= r1; r++) {
      const rowBase = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        const cell = rowBase + c;
        const end = this.start[cell + 1]!;
        visited += end - this.start[cell]!;
        for (let k = this.start[cell]!; k < end; k++) {
          const i = this.order[k]!;
          const dx = this.xs[i]! - x;
          const dy = this.ys[i]! - y;
          const d2 = dx * dx + dy * dy;
          if ((d2 < bestD2 || (d2 === bestD2 && i > best)) && accept(i)) {
            bestD2 = d2;
            best = i;
          }
        }
      }
    }
    this.lastVisited = visited;
    return best;
  }

  x(i: number): number {
    return this.xs[i]!;
  }

  y(i: number): number {
    return this.ys[i]!;
  }
}
