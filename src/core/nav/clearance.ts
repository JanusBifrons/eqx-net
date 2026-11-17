/**
 * The free-space (clearance) map (navigation plan, Stage E slice 3).
 *
 * A square-cell grid over a patch of a sector. Each cell holds how far its
 * centre is from the nearest blocked cell's centre, in world units: an exact
 * Euclidean distance transform (Felzenszwalb & Huttenlocher, separable 1-D
 * lower envelopes of parabolas), not a chamfer estimate. A cell is blocked
 * when its centre lies inside an obstacle: inside one of its convex `parts`
 * when it has them, else inside its circle. A hull of clearance `c` fits at a
 * cell whose value is >= c (to within one cell).
 *
 * Input is the same `GridObstacle[]` the room's one obstacle gatherer fills
 * (`SectorObstacles.rocks`), so placement, line of sight and navigation all
 * see the same rocks.
 *
 * Allocation-free once warm: the distance field and the 1-D scratch are typed
 * arrays grown only for a bigger grid (#14). Pure core: no clock, no I/O.
 */
import type { GridObstacle } from '../structures/Grid.js';

type Part = ReadonlyArray<{ readonly x: number; readonly y: number }>;

/** Is local point (px, py) inside convex CCW polygon `poly` (edges included)? */
function insideConvex(poly: Part, px: number, py: number): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[j]!, b = poly[i]!;
    if ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x) < 0) return false;
  }
  return true;
}

export class ClearanceGrid {
  /** World x / y of the grid's lower-left corner. */
  originX = 0;
  originY = 0;
  /** Cell side, world units. */
  cell = 1;
  cols = 0;
  rows = 0;
  /** Cells blocked by the last build. */
  blockedCount = 0;
  /** Row-major distances (world units) from each cell centre to the nearest
   *  blocked cell centre; 0 on a blocked cell, Infinity with nothing blocked. */
  dist = new Float32Array(0);

  // Squared distances in cell units, then the 1-D transform's scratch.
  private sq = new Float64Array(0);
  private f = new Float64Array(0);
  private d = new Float64Array(0);
  private v = new Int32Array(0);
  private z = new Float64Array(0);

  /** Rebuilds the map for a `cols`×`rows` grid of `cell`-sized cells whose
   *  lower-left corner is (originX, originY). */
  build(originX: number, originY: number, cols: number, rows: number, cell: number, obstacles: readonly GridObstacle[]): void {
    this.originX = originX; this.originY = originY; this.cell = cell;
    this.cols = cols; this.rows = rows;
    const n = cols * rows;
    this.ensure(n, Math.max(cols, rows));
    const sq = this.sq;
    sq.fill(Infinity, 0, n);
    this.blockedCount = 0;
    for (let k = 0; k < obstacles.length; k++) this.stamp(obstacles[k]!);
    // Columns, then rows (separable exact EDT on squared distances).
    const f = this.f, d = this.d;
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) f[y] = sq[y * cols + x]!;
      this.edt1d(rows);
      for (let y = 0; y < rows; y++) sq[y * cols + x] = d[y]!;
    }
    const out = this.dist;
    for (let y = 0; y < rows; y++) {
      const row = y * cols;
      for (let x = 0; x < cols; x++) f[x] = sq[row + x]!;
      this.edt1d(cols);
      for (let x = 0; x < cols; x++) out[row + x] = Math.sqrt(d[x]!) * cell;
    }
  }

  /** Clearance at world (x, y): the value of the cell it falls in, clamped to
   *  the grid's edge cells. */
  at(x: number, y: number): number {
    let cx = Math.floor((x - this.originX) / this.cell), cy = Math.floor((y - this.originY) / this.cell);
    if (cx < 0) cx = 0; else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0; else if (cy >= this.rows) cy = this.rows - 1;
    return this.dist[cy * this.cols + cx]!;
  }

  /** Marks every cell whose centre lies inside `o`. */
  private stamp(o: GridObstacle): void {
    const { cols, rows, cell, originX, originY, sq } = this;
    const r = o.radius;
    const x0 = Math.max(0, Math.ceil((o.x - r - originX) / cell - 0.5));
    const x1 = Math.min(cols - 1, Math.floor((o.x + r - originX) / cell - 0.5));
    const y0 = Math.max(0, Math.ceil((o.y - r - originY) / cell - 0.5));
    const y1 = Math.min(rows - 1, Math.floor((o.y + r - originY) / cell - 0.5));
    if (x0 > x1 || y0 > y1) return;
    const parts = o.parts, angle = o.angle ?? 0;
    const c = Math.cos(-angle), s = Math.sin(-angle), r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const wy = originY + (y + 0.5) * cell - o.y;
      for (let x = x0; x <= x1; x++) {
        const i = y * cols + x;
        if (sq[i] === 0) continue;
        const wx = originX + (x + 0.5) * cell - o.x;
        let hit: boolean;
        if (parts === undefined) {
          hit = wx * wx + wy * wy <= r2;
        } else {
          const lx = wx * c - wy * s, ly = wx * s + wy * c;
          hit = false;
          for (let p = 0; p < parts.length && !hit; p++) hit = insideConvex(parts[p]!, lx, ly);
        }
        if (hit) { sq[i] = 0; this.blockedCount++; }
      }
    }
  }

  /** 1-D squared-distance transform of f[0..n) into d[0..n). */
  private edt1d(n: number): void {
    const f = this.f, d = this.d, v = this.v, z = this.z;
    // Skip leading Infinity samples: they never form a parabola.
    let k = -1;
    for (let q = 0; q < n; q++) {
      const fq = f[q]!;
      if (fq === Infinity) continue;
      if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
      let s: number;
      for (;;) { // z[0] = -Infinity, so this stops at k = 0 at the latest
        const p = v[k]!;
        s = ((fq + q * q) - (f[p]! + p * p)) / (2 * (q - p));
        if (s > z[k]!) break;
        k--;
      }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    if (k < 0) { d.fill(Infinity, 0, n); return; }
    let j = 0;
    for (let q = 0; q < n; q++) {
      while (z[j + 1]! < q) j++;
      const p = v[j]!, dq = q - p;
      d[q] = dq * dq + f[p]!;
    }
  }

  private ensure(cells: number, line: number): void {
    if (this.sq.length < cells) { this.sq = new Float64Array(cells); this.dist = new Float32Array(cells); }
    else if (this.dist.length < cells) this.dist = new Float32Array(cells);
    if (this.f.length < line) {
      this.f = new Float64Array(line); this.d = new Float64Array(line);
      this.v = new Int32Array(line); this.z = new Float64Array(line + 1);
    }
  }
}
