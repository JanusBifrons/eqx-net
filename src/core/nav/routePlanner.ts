/**
 * The in-sector route planner (navigation plan, Stage E slice 6). Runs on the
 * nav worker over one field's two layers; pure and allocation-free after
 * warm-up (scratch grows only on a longer path than seen before).
 *
 * A request is a start, a goal and a hull clearance (how far the hull's
 * centre must stay from rock, #18: the caller derives it from `shipTuning`).
 *
 * 1. Straight line clear ⇒ that is the route (no search).
 * 2. Coarse A* over the whole field's ~2 km cells (`CoarseFieldMap`, cells
 *    with room for the hull): which way round the field, which lane.
 * 3. Fine A* over 64 u cells in a window of chunks round the start (the fine
 *    layer where its chunk is loaded, the coarse layer elsewhere), to where
 *    the coarse path leaves the window, or to the goal inside it.
 * 4. String-pull the joined path: keep only the turns a straight line can't
 *    skip. Past the window the route follows the coarse path; the ship asks
 *    again as it goes (slice 9).
 *
 * Room at a point is a distance, so line checks step by the room to spare
 * (sphere tracing), never further than the fine layer can see.
 */
import { CHUNK_SIZE } from '../terrain/fieldLayout.js';
import { GraphSearch, type SearchGoal, type SearchGraph } from './search.js';
import type { CoarseFieldMap } from './coarseField.js';
import { FINE_NAV_CELL, FINE_NAV_DIAG, FINE_NAV_REACH, type FineFieldLayer } from './fineField.js';

/** Most waypoints one route carries (the rest comes from asking again). */
export const NAV_ROUTE_MAX_POINTS = 64;
/** Chunks on a side of the fine search window (centred on the start's chunk). */
export const NAV_FINE_WINDOW_CHUNKS = 5;
/** Per-request expansion caps (coarse map, fine window). */
export const NAV_COARSE_EXPAND_CAP = 30_000;
export const NAV_FINE_EXPAND_CAP = 60_000;

/** `straight`: the line is clear; `route`: waypoints found; `none`: no way at this clearance. */
/** `nearest`: no way fits, the route ends at the reachable point nearest the
 *  goal (owner, 2026-11-17: go there and wait). */
export type NavRouteStatus = 'straight' | 'route' | 'nearest' | 'none';

const W = (NAV_FINE_WINDOW_CHUNKS * CHUNK_SIZE) / FINE_NAV_CELL;
const HALF_WIN = Math.floor(NAV_FINE_WINDOW_CHUNKS / 2);
const NDX = [1, -1, 0, 0, 1, 1, -1, -1];
const NDY = [0, 0, 1, -1, 1, -1, 1, -1];
const DIAG = FINE_NAV_CELL * Math.SQRT2;
/** How near an intermediate fine target counts as reached (it may sit on a rock). */
const FINE_HANDOFF_RADIUS = FINE_NAV_CELL * 6;

/** The fine window as a search graph: cell `i` is admitted when the hull fits
 *  there (near the start, wherever it fits no worse than at the start, so a
 *  ship tight against a rock can still back out). */
class FineWindow implements SearchGraph {
  readonly nodeCount = W * W;
  ox = 0;
  oy = 0;
  c = 0;
  sx = 0;
  sy = 0;
  startRoom = 0;
  private readonly room = new Float32Array(W * W);
  private readonly seen = new Uint32Array(W * W);
  private run = 0;

  constructor(private readonly p: RoutePlanner) {}

  reset(): void {
    if (++this.run === 0xffffffff) { this.seen.fill(0); this.run = 1; }
  }
  x(i: number): number { return this.ox + ((i % W) + 0.5) * FINE_NAV_CELL; }
  y(i: number): number { return this.oy + (((i / W) | 0) + 0.5) * FINE_NAV_CELL; }
  /** Cell holding (x, y), or -1 outside the window. */
  cellAt(x: number, y: number): number {
    const gx = Math.floor((x - this.ox) / FINE_NAV_CELL), gy = Math.floor((y - this.oy) / FINE_NAV_CELL);
    return gx < 0 || gy < 0 || gx >= W || gy >= W ? -1 : gy * W + gx;
  }
  private admits(i: number): boolean {
    if (this.seen[i] !== this.run) { this.seen[i] = this.run; this.room[i] = this.p.roomAt(this.x(i), this.y(i)); }
    const r = this.room[i]!;
    if (r >= this.c) return true;
    const dx = this.x(i) - this.sx, dy = this.y(i) - this.sy, near = this.c + 2 * FINE_NAV_CELL;
    return dx * dx + dy * dy <= near * near && r >= this.startRoom;
  }
  edgeCount(): number { return 8; }
  edgeTo(i: number, k: number): number {
    const gx = (i % W) + NDX[k]!, gy = ((i / W) | 0) + NDY[k]!;
    if (gx < 0 || gy < 0 || gx >= W || gy >= W) return i;
    const j = gy * W + gx;
    if (!this.admits(j)) return i;
    // A diagonal never cuts a corner: both cells beside it must admit too.
    if (k >= 4 && (!this.admits(gy * W + (i % W)) || !this.admits(((i / W) | 0) * W + gx))) return i;
    return j;
  }
  edgeCost(_i: number, k: number): number { return k < 4 ? FINE_NAV_CELL : DIAG; }
}

/** Reach any cell within `radius` of (tx, ty); straight-line heuristic. */
class FineGoal implements SearchGoal {
  tx = 0;
  ty = 0;
  radius = 0;
  constructor(private readonly win: FineWindow) {}
  private d(i: number): number {
    const dx = this.win.x(i) - this.tx, dy = this.win.y(i) - this.ty;
    return Math.sqrt(dx * dx + dy * dy);
  }
  isGoal(i: number): boolean { return this.d(i) <= this.radius; }
  heuristic(i: number): number { return Math.max(0, this.d(i) - this.radius); }
}

/** One coarse cell; heuristic from best point to best point. */
class CoarseGoal implements SearchGoal {
  map: CoarseFieldMap | null = null;
  target = -1;
  isGoal(i: number): boolean { return i === this.target; }
  heuristic(i: number): number {
    const m = this.map!, dx = m.bestX[i]! - m.bestX[this.target]!, dy = m.bestY[i]! - m.bestY[this.target]!;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

export class RoutePlanner {
  private readonly search = new GraphSearch();
  private readonly win = new FineWindow(this);
  private readonly fGoal = new FineGoal(this.win);
  private readonly cGoal = new CoarseGoal();
  private coarse: CoarseFieldMap | null = null;
  private fine: FineFieldLayer | null = null;
  private cPath = new Int32Array(256);
  /** The joined path before string-pulling, packed x, y. */
  private poly = new Float64Array(1024);
  private polyLen = 0;

  /** Nodes expanded by the last request, both layers (the count gate's work counter). */
  expanded = 0;
  /** Outcome of the last request. */
  status: NavRouteStatus = 'none';

  /** Room (max hull clearance) at (x, y): the fine layer where it knows (a
   *  loaded chunk, rock within its reach), else the coarse layer. The fine
   *  value less a cell diagonal: true anywhere in the cell, not just its centre. */
  roomAt(x: number, y: number): number {
    const f = this.fine!.clearanceAt(x, y);
    if (f >= 0 && f < FINE_NAV_REACH) return Math.max(0, f - FINE_NAV_DIAG);
    const r = this.coarse!.roomAt(x, y);
    return f >= 0 ? Math.max(r, FINE_NAV_REACH - FINE_NAV_DIAG) : r;
  }

  /** Can a hull of clearance `c` fly straight from a to b? Room is a lower
   *  bound for the whole 64 u cell, so with room to spare the check leaps by
   *  it, and when tight it visits every cell the segment crosses. */
  segmentClear(ax: number, ay: number, bx: number, by: number, c: number): boolean {
    const dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return this.roomAt(ax, ay) >= c;
    const ux = dx / len, uy = dy / len;
    let t = 0;
    for (;;) {
      const x = ax + ux * t, y = ay + uy * t, r = this.roomAt(x, y);
      if (r < c) return false;
      if (t >= len) return true;
      const leap = Math.min(r - c, FINE_NAV_REACH);
      // Distance to the next cell boundary along the segment (a hair past it).
      const gx = Math.floor(x / FINE_NAV_CELL), gy = Math.floor(y / FINE_NAV_CELL);
      const tx = ux > 0 ? ((gx + 1) * FINE_NAV_CELL - x) / ux : ux < 0 ? (gx * FINE_NAV_CELL - x) / ux : Infinity;
      const ty = uy > 0 ? ((gy + 1) * FINE_NAV_CELL - y) / uy : uy < 0 ? (gy * FINE_NAV_CELL - y) / uy : Infinity;
      t = Math.min(len, t + Math.max(leap, Math.min(tx, ty) + 1e-6));
    }
  }

  /** Plans from (sx, sy) to (tx, ty) for clearance `c`. Writes the waypoints
   *  after the start into `out` (packed x, y; the goal last unless cut short at
   *  `out`'s size) and returns how many; sets {@link status} and {@link expanded}. */
  plan(coarse: CoarseFieldMap, fine: FineFieldLayer, sx: number, sy: number, tx: number, ty: number, c: number, out: Float64Array): number {
    this.coarse = coarse; this.fine = fine;
    this.expanded = 0;
    if (this.segmentClear(sx, sy, tx, ty, c)) {
      out[0] = tx; out[1] = ty;
      this.status = 'straight';
      return 1;
    }
    this.status = 'none';
    // The fine window round the start.
    const win = this.win;
    win.ox = (Math.floor(sx / CHUNK_SIZE) - HALF_WIN) * CHUNK_SIZE;
    win.oy = (Math.floor(sy / CHUNK_SIZE) - HALF_WIN) * CHUNK_SIZE;
    win.c = c; win.sx = sx; win.sy = sy;
    win.startRoom = Math.min(c, this.roomAt(sx, sy));
    win.reset();
    const lo = FINE_NAV_CELL, hiX = win.ox + W * FINE_NAV_CELL - lo, hiY = win.oy + W * FINE_NAV_CELL - lo;
    const loX = win.ox + lo, loY = win.oy + lo;
    const inside = (x: number, y: number): boolean => x > loX && x < hiX && y > loY && y < hiY;
    // 1. Coarse: which way round (not needed with the goal in the window,
    //    and the coarse layer reads the field's inside as solid).
    const cs = clampedCell(coarse, sx, sy), cg = clampedCell(coarse, tx, ty);
    let cLen = 1, partial = false, gx = tx, gy = ty;
    this.cPath[0] = cs;
    if (cs !== cg && !inside(tx, ty)) {
      coarse.clearance = c;
      this.cGoal.map = coarse; this.cGoal.target = cg;
      let hit = this.search.search(coarse, cs, this.cGoal, NAV_COARSE_EXPAND_CAP);
      this.expanded += this.search.expanded;
      if (hit < 0) {
        // No way: head for the reached cell nearest the goal, if nearer than here.
        hit = this.search.nearest;
        if (hit < 0 || hit === cs) return 0;
        partial = true; gx = coarse.bestX[hit]!; gy = coarse.bestY[hit]!;
      }
      cLen = this.search.hops(hit) + 1;
      if (this.cPath.length < cLen) this.cPath = new Int32Array(cLen * 2);
      for (let t = hit, k = cLen - 1; k >= 0; t = this.search.prev(t), k--) this.cPath[k] = t;
    }
    // Coarse polyline: start, the inner cells' best points, goal (in `poly` for now).
    this.polyLen = 0;
    this.push(sx, sy);
    for (let k = 1; k < cLen - 1; k++) this.push(coarse.bestX[this.cPath[k]!]!, coarse.bestY[this.cPath[k]!]!);
    this.push(gx, gy);
    // 2. Fine search in the window to the goal, or to where the coarse path leaves it.
    const P = this.poly, n = this.polyLen;
    let k = 0; // last coarse point inside the window
    while (k + 1 < n && inside(P[(k + 1) * 2]!, P[(k + 1) * 2 + 1]!)) k++;
    let fx: number, fy: number, restFrom: number;
    if (k === n - 1) {
      fx = gx; fy = gy; restFrom = n; this.fGoal.radius = FINE_NAV_CELL * 0.75;
    } else {
      // Where segment k → k+1 leaves the window.
      const ax = P[k * 2]!, ay = P[k * 2 + 1]!, bx = P[(k + 1) * 2]!, by = P[(k + 1) * 2 + 1]!;
      let u = 1;
      if (bx > hiX) u = Math.min(u, (hiX - ax) / (bx - ax));
      if (bx < loX) u = Math.min(u, (loX - ax) / (bx - ax));
      if (by > hiY) u = Math.min(u, (hiY - ay) / (by - ay));
      if (by < loY) u = Math.min(u, (loY - ay) / (by - ay));
      u = Math.max(0, u);
      fx = ax + (bx - ax) * u; fy = ay + (by - ay) * u;
      restFrom = k + 1;
      this.fGoal.radius = FINE_HANDOFF_RADIUS;
    }
    this.fGoal.tx = fx; this.fGoal.ty = fy;
    const from = win.cellAt(sx, sy);
    let hit = this.search.search(win, from, this.fGoal, NAV_FINE_EXPAND_CAP);
    this.expanded += this.search.expanded;
    let fineEnd = false;
    if (hit < 0) {
      // No way (or the cap): the reached cell nearest the goal, if nearer than here.
      hit = this.search.nearest;
      if (hit < 0 || hit === from) return 0;
      partial = true; fineEnd = true;
    }
    // Joined path into `poly`, after the coarse rest (kept at its tail for now).
    const fineCells = this.search.hops(hit);
    const restLen = fineEnd ? 0 : n - restFrom;
    const need = (1 + fineCells + 1 + restLen) * 2;
    if (this.poly.length < need * 2) this.growPoly(need * 2);
    const Q = this.poly;
    // Move the coarse rest out of the way (to the far end of the buffer).
    const restAt = Q.length - restLen * 2;
    Q.copyWithin(restAt, restFrom * 2, n * 2);
    // Start, then fine cell centres from the start (exclusive) to the hit.
    Q[0] = sx; Q[1] = sy;
    for (let t = hit, j = fineCells; j >= 1; t = this.search.prev(t), j--) { Q[j * 2] = win.x(t); Q[j * 2 + 1] = win.y(t); }
    let len = fineCells + 1;
    if (fineEnd) {
      // Ends on the nearest cell's centre (already the last point).
    } else if (restLen === 0) {
      // The goal itself replaces the last cell centre (it is in that cell's reach).
      if (len > 1) len--;
      Q[len * 2] = gx; Q[len * 2 + 1] = gy; len++;
    } else {
      Q.copyWithin(len * 2, restAt, restAt + restLen * 2);
      len += restLen;
    }
    // 3. String-pull.
    const max = out.length >> 1;
    let a = 0, count = 0;
    while (a < len - 1 && count < max) {
      let j = a + 1;
      while (j + 1 < len && this.segmentClear(Q[a * 2]!, Q[a * 2 + 1]!, Q[(j + 1) * 2]!, Q[(j + 1) * 2 + 1]!, c)) j++;
      out[count * 2] = Q[j * 2]!; out[count * 2 + 1] = Q[j * 2 + 1]!;
      count++;
      a = j;
    }
    this.status = partial ? 'nearest' : 'route';
    return count;
  }

  private push(x: number, y: number): void {
    if (this.poly.length < (this.polyLen + 1) * 2) this.growPoly(this.poly.length * 2);
    this.poly[this.polyLen * 2] = x; this.poly[this.polyLen * 2 + 1] = y;
    this.polyLen++;
  }

  private growPoly(size: number): void {
    const p = new Float64Array(size);
    p.set(this.poly.subarray(0, this.polyLen * 2));
    this.poly = p;
  }
}

/** Coarse cell holding (x, y), clamped onto the map (beyond it is open space). */
function clampedCell(m: CoarseFieldMap, x: number, y: number): number {
  const cx = Math.min(m.cols - 1, Math.max(0, Math.floor((x - m.originX) / m.cell)));
  const cy = Math.min(m.rows - 1, Math.max(0, Math.floor((y - m.originY) / m.cell)));
  return cy * m.cols + cx;
}
