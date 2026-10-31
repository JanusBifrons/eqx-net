/**
 * Allocation-free "first base wall along this ray" query
 * (plan: soft-leaping-truffle, PR-V2; research §4.2).
 *
 * The server main thread has no live Rapier world — every weapon path is an
 * analytic loop — so base geometry answers ray queries itself. The query
 * runs against the SAME union-outline segments the colliders are built from
 * (`baseOutlineSegments`), bucketed into a uniform cell grid, walked with a
 * DDA traversal along the ray. A segment spanning several cells is tested at
 * most once per query (generation stamp, no Set).
 *
 * Hot-path contract (Invariant #14): `rayFirst` allocates nothing. The grid is
 * built once per base (and on a destroy-rebuild). Op-count is exposed for the
 * budget lock (cells + segments visited per query).
 */
import type { BaseLayout } from './baseLayout.js';
import { baseOutlineSegments } from './baseChunkMesh.js';

/** Grid cell size (u). */
export const BASE_RAY_CELL = 128;

export class BaseRayGrid {
  /** World-space segments, flat [x0, y0, x1, y1, ...]. */
  private segs: Float64Array = new Float64Array(0);
  private stamp: Uint32Array = new Uint32Array(0);
  private gen = 0;
  /** CSR buckets: cellStart[c]..cellStart[c+1] index into cellSegs. */
  private cellStart: Uint32Array = new Uint32Array(1);
  private cellSegs: Uint32Array = new Uint32Array(0);
  private n = 0; // cells per side
  private minX = 0;
  private minY = 0;

  /** Op counters for the last query (budget lock). */
  lastCellsVisited = 0;
  lastSegmentsTested = 0;

  /** (Re)build from a layout (+ optional destroy mask). Not a hot path. */
  build(l: BaseLayout, dead?: Uint32Array | null): void {
    const local = baseOutlineSegments(l, dead);
    const count = local.length / 4;
    this.segs = new Float64Array(local.length);
    for (let i = 0; i < local.length; i += 2) {
      this.segs[i] = local[i]! + l.descriptor.x;
      this.segs[i + 1] = local[i + 1]! + l.descriptor.y;
    }
    this.stamp = new Uint32Array(count);
    this.gen = 0;
    this.minX = l.descriptor.x - l.half;
    this.minY = l.descriptor.y - l.half;
    this.n = Math.max(1, Math.ceil((2 * l.half) / BASE_RAY_CELL));
    const cells = this.n * this.n;
    const counts = new Uint32Array(cells + 1);
    const forEachCell = (s: number, fn: (c: number) => void): void => {
      const ax = this.segs[s * 4]!, ay = this.segs[s * 4 + 1]!, bx = this.segs[s * 4 + 2]!, by = this.segs[s * 4 + 3]!;
      const cx0 = this.cellX(Math.min(ax, bx)), cx1 = this.cellX(Math.max(ax, bx));
      const cy0 = this.cellY(Math.min(ay, by)), cy1 = this.cellY(Math.max(ay, by));
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * this.n + cx);
    };
    for (let s = 0; s < count; s++) forEachCell(s, (c) => { counts[c + 1]!++; });
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!;
    this.cellStart = counts.slice();
    this.cellSegs = new Uint32Array(counts[cells]!);
    const fill = counts.slice(0, cells);
    for (let s = 0; s < count; s++) forEachCell(s, (c) => { this.cellSegs[fill[c]!++] = s; });
  }

  get segmentCount(): number {
    return this.segs.length / 4;
  }

  private cellX(x: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor((x - this.minX) / BASE_RAY_CELL)));
  }

  private cellY(y: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor((y - this.minY) / BASE_RAY_CELL)));
  }

  /**
   * Distance along the (unit) ray to the first wall segment within `maxDist`,
   * or -1 when nothing is hit. Allocation-free.
   */
  rayFirst(ox: number, oy: number, dx: number, dy: number, maxDist: number): number {
    this.lastCellsVisited = 0;
    this.lastSegmentsTested = 0;
    if (this.segs.length === 0) return -1;
    // Clip the ray to the grid box so the DDA starts inside it.
    const size = this.n * BASE_RAY_CELL;
    let t0 = 0;
    let t1 = maxDist;
    const bx0 = this.minX, by0 = this.minY, bx1 = this.minX + size, by1 = this.minY + size;
    if (dx !== 0) {
      const ta = (bx0 - ox) / dx, tb = (bx1 - ox) / dx;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    } else if (ox < bx0 || ox > bx1) return -1;
    if (dy !== 0) {
      const ta = (by0 - oy) / dy, tb = (by1 - oy) / dy;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    } else if (oy < by0 || oy > by1) return -1;
    if (t0 > t1) return -1;

    if (++this.gen === 0xffffffff) { this.stamp.fill(0); this.gen = 1; }
    const sx = ox + dx * t0, sy = oy + dy * t0;
    let cx = this.cellX(sx), cy = this.cellY(sy);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const nextBX = this.minX + (cx + (dx > 0 ? 1 : 0)) * BASE_RAY_CELL;
    const nextBY = this.minY + (cy + (dy > 0 ? 1 : 0)) * BASE_RAY_CELL;
    let tMaxX = dx !== 0 ? (nextBX - ox) / dx : Infinity;
    let tMaxY = dy !== 0 ? (nextBY - oy) / dy : Infinity;
    const tDeltaX = dx !== 0 ? BASE_RAY_CELL / Math.abs(dx) : Infinity;
    const tDeltaY = dy !== 0 ? BASE_RAY_CELL / Math.abs(dy) : Infinity;

    let best = -1;
    for (;;) {
      this.lastCellsVisited++;
      const c = cy * this.n + cx;
      for (let k = this.cellStart[c]!; k < this.cellStart[c + 1]!; k++) {
        const s = this.cellSegs[k]!;
        if (this.stamp[s] === this.gen) continue;
        this.stamp[s] = this.gen;
        this.lastSegmentsTested++;
        const t = raySegment(ox, oy, dx, dy, this.segs, s * 4);
        if (t >= 0 && t <= maxDist && (best < 0 || t < best)) best = t;
      }
      // The nearest hit inside this cell can't be beaten by a later cell.
      const cellExit = Math.min(tMaxX, tMaxY);
      if (best >= 0 && best <= cellExit) return best;
      if (cellExit > t1) return best;
      if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX; } else { cy += stepY; tMaxY += tDeltaY; }
      if (cx < 0 || cy < 0 || cx >= this.n || cy >= this.n) return best;
    }
  }
}

/** Ray (unit dir) vs segment: distance along the ray, or -1. */
function raySegment(ox: number, oy: number, dx: number, dy: number, s: Float64Array, i: number): number {
  const ax = s[i]!, ay = s[i + 1]!;
  const ex = s[i + 2]! - ax, ey = s[i + 3]! - ay;
  const denom = dx * ey - dy * ex;
  if (denom === 0) return -1; // parallel
  const qx = ax - ox, qy = ay - oy;
  const t = (qx * ey - qy * ex) / denom;
  const u = (qx * dy - qy * dx) / denom;
  return t >= 0 && u >= 0 && u <= 1 ? t : -1;
}
