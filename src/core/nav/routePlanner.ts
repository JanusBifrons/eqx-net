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
import { HEADING_NODE_SHIFT, HeadingCoarseGraph, type CoarseFieldMap } from './coarseField.js';
import { FINE_NAV_CELL, FINE_NAV_DIAG, FINE_NAV_REACH, type FineFieldLayer } from './fineField.js';
import { navTurnRoom } from '../../shared-types/shipScale/navTuning.js';

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
/** Exact samples on a side of a tight cell (16 u apart for 64 u cells). */
const FINE_SAMPLES = 4;
/** Shortest step of an exact sphere trace (world u): a line grazing a rock
 *  closer than this past the hull's clearance still counts as clear. */
const EXACT_MIN_STEP = 2;
/** How near an intermediate fine target counts as reached (it may sit on a rock). */
const FINE_HANDOFF_RADIUS = FINE_NAV_CELL * 6;

/** The fine window as a search graph: cell `i` is admitted when the hull fits
 *  there (near the start, wherever it fits no worse than at the start, so a
 *  ship tight against a rock can still back out). Where the cell's bound is
 *  too rough to tell (a tight street), the cell is sampled exactly
 *  (`FINE_SAMPLES`² points) and its node moves to the roomiest sample; an
 *  edge touching such a node is checked exactly. */
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
  /** Node point of a cell sampled exactly this run (else its centre). */
  private readonly nx = new Float32Array(W * W);
  private readonly ny = new Float32Array(W * W);
  private readonly exact = new Uint8Array(W * W);
  private run = 0;

  constructor(private readonly p: RoutePlanner) {}

  reset(): void {
    if (++this.run === 0xffffffff) { this.seen.fill(0); this.run = 1; }
  }
  x(i: number): number { return this.seen[i] === this.run && this.exact[i] ? this.nx[i]! : this.cx(i); }
  y(i: number): number { return this.seen[i] === this.run && this.exact[i] ? this.ny[i]! : this.cy(i); }
  private cx(i: number): number { return this.ox + ((i % W) + 0.5) * FINE_NAV_CELL; }
  private cy(i: number): number { return this.oy + (((i / W) | 0) + 0.5) * FINE_NAV_CELL; }
  /** Cell holding (x, y), or -1 outside the window. */
  cellAt(x: number, y: number): number {
    const gx = Math.floor((x - this.ox) / FINE_NAV_CELL), gy = Math.floor((y - this.oy) / FINE_NAV_CELL);
    return gx < 0 || gy < 0 || gx >= W || gy >= W ? -1 : gy * W + gx;
  }
  private admits(i: number): boolean {
    if (this.seen[i] !== this.run) this.sample(i);
    const r = this.room[i]!;
    if (r >= this.c) return true;
    const dx = this.cx(i) - this.sx, dy = this.cy(i) - this.sy, near = this.c + 2 * FINE_NAV_CELL;
    return dx * dx + dy * dy <= near * near && r >= this.startRoom;
  }
  /** Works out cell `i`'s room this run: its bound, or when that is too
   *  rough for this hull, the best of its exact samples. */
  private sample(i: number): void {
    const x0 = this.cx(i), y0 = this.cy(i), c = this.c;
    this.seen[i] = this.run; this.exact[i] = 0;
    let r = this.p.roomAt(x0, y0);
    if (r < c && this.p.tight(x0, y0, c)) {
      const step = FINE_NAV_CELL / FINE_SAMPLES, lo = -FINE_NAV_CELL / 2 + step / 2;
      let best = -1, bx = x0, by = y0;
      for (let a = 0; a < FINE_SAMPLES; a++) for (let b = 0; b < FINE_SAMPLES; b++) {
        const px = x0 + lo + b * step, py = y0 + lo + a * step, e = this.p.exactRoom(px, py, c);
        if (e > best) { best = e; bx = px; by = py; }
      }
      if (best >= c) { r = best; this.exact[i] = 1; this.nx[i] = bx; this.ny[i] = by; }
    }
    this.room[i] = r;
  }
  edgeCount(): number { return 8; }
  edgeTo(i: number, k: number): number {
    const gx = (i % W) + NDX[k]!, gy = ((i / W) | 0) + NDY[k]!;
    if (gx < 0 || gy < 0 || gx >= W || gy >= W) return i;
    const j = gy * W + gx;
    if (!this.admits(j)) return i;
    // A node moved to an exact sample: the edge itself is checked exactly.
    if (this.exact[j] || (this.seen[i] === this.run && this.exact[i])) {
      return this.p.segmentClear(this.x(i), this.y(i), this.x(j), this.y(j), this.c) ? j : i;
    }
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
  /** 3 over the heading graph (node = cell × 8 + step), else 0. */
  shift = 0;
  isGoal(i: number): boolean { return i >> this.shift === this.target; }
  heuristic(i: number): number {
    const m = this.map!, c = i >> this.shift, dx = m.bestX[c]! - m.bestX[this.target]!, dy = m.bestY[c]! - m.bestY[this.target]!;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

export class RoutePlanner {
  private readonly search = new GraphSearch();
  private readonly win = new FineWindow(this);
  private readonly fGoal = new FineGoal(this.win);
  private readonly cGoal = new CoarseGoal();
  private readonly headed = new HeadingCoarseGraph();
  private coarse: CoarseFieldMap | null = null;
  private fine: FineFieldLayer | null = null;
  private cPath = new Int32Array(256);
  /** The joined path before string-pulling, packed x, y. */
  private poly = new Float64Array(1024);
  private polyLen = 0;
  /** This request's comfort clearance (`plan`). */
  private comfort = 0;
  /** The hull's full clearance (its length): what a turn needs. Above the
   *  planning clearance only on the beam pass ("width on straights"). */
  private full = 0;
  /** The hull's beam clearance for this request (= `full` for a short hull). */
  private beam = 0;

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

  /** Is the fine cell bound at (x, y) too rough to tell whether a hull of
   *  clearance `c` fits there? (The true room is at most the cell value plus
   *  a diagonal: half for the stamping pad, half for the cell.) */
  tight(x: number, y: number, c: number): boolean {
    const f = this.fine!.clearanceAt(x, y);
    return f >= 0 && f < FINE_NAV_REACH && f - FINE_NAV_DIAG < c && f + FINE_NAV_DIAG >= c;
  }

  /** The exact room at (x, y) (distance to the nearest rock outline), capped
   *  a cell past `c`. Only where {@link tight} says the bound can't tell. */
  exactRoom(x: number, y: number, c: number): number {
    return this.fine!.exactAt(x, y, Math.min(FINE_NAV_REACH, c + FINE_NAV_CELL));
  }

  /** Can a hull of clearance `c` fly straight from a to b? Room is a lower
   *  bound for the whole 64 u cell, so with room to spare the check leaps by
   *  it, and when tight it visits every cell the segment crosses. Where the
   *  bound is too rough ({@link tight}) it traces the exact distance instead,
   *  leaping by the exact slack (at least `EXACT_MIN_STEP`). */
  segmentClear(ax: number, ay: number, bx: number, by: number, c: number): boolean {
    const dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return this.roomAt(ax, ay) >= c;
    const ux = dx / len, uy = dy / len;
    let t = 0;
    for (;;) {
      const x = ax + ux * t, y = ay + uy * t;
      let r = this.roomAt(x, y);
      if (r < c && this.tight(x, y, c)) {
        r = this.exactRoom(x, y, c);
        if (r < c) return false;
        if (t >= len) return true;
        t = Math.min(len, t + Math.max(r - c, EXACT_MIN_STEP));
        continue;
      }
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
   *  `out`'s size) and returns how many; sets {@link status} and {@link expanded}.
   *  With a `heading` (ship angle) and `turnRadius` the coarse search knows
   *  which way the ship points (slice 11): no turn past 45° a step where the
   *  room is under the turning radius, turns cost. A hull wider than the fine
   *  layer's reach (a capital) then plans on the coarse layer alone.
   *  `comfort` (≥ `c`; owner 2026-11-19, "margin where room"): the clearance a
   *  route keeps when any way fits it (the hull's shield clear of rock). Only
   *  when none does is it planned again at `c`, its shortcuts still keeping
   *  `comfort` wherever the unpulled path does.
   *  `beam` (< `c`, a long hull with a heading; owner 2026-11-19, "width on
   *  straights"): straight runs need only the beam, each turn the room its
   *  sweep takes (`navTurnRoom`) along its arc. Planned first; when its
   *  turns don't fit, planned again on the full clearance. */
  plan(coarse: CoarseFieldMap, fine: FineFieldLayer, sx: number, sy: number, tx: number, ty: number, c: number, out: Float64Array,
    heading = NaN, turnRadius = 0, comfort = c, beam = c): number {
    this.coarse = coarse; this.fine = fine;
    this.expanded = 0;
    this.full = c; this.beam = Math.min(beam, c);
    if (beam < c && c > FINE_NAV_REACH && turnRadius > 0 && Number.isFinite(heading)) {
      this.comfort = beam;
      const n = this.planAt(sx, sy, tx, ty, beam, out, heading, turnRadius);
      // No way even on the beam: none on the full clearance either.
      if (this.failed() || this.turnsFit(sx, sy, out, n, heading, turnRadius, beam)) return n;
      // Its turns didn't fit (a gap it fits only straight through): plan again
      // where a 45° turn fits anywhere, so a lane stays open but such gaps don't.
      const t45 = navTurnRoom(c, beam, Math.SQRT1_2, Math.SQRT1_2);
      if (t45 < c) {
        this.comfort = t45;
        const m = this.planAt(sx, sy, tx, ty, t45, out, heading, turnRadius);
        if (this.failed() || this.turnsFit(sx, sy, out, m, heading, turnRadius, beam)) return m;
      }
    }
    if (comfort > c) {
      this.comfort = comfort;
      const n = this.planAt(sx, sy, tx, ty, comfort, out, heading, turnRadius);
      if (this.status === 'straight' || this.status === 'route') return n;
    }
    this.comfort = Math.max(c, comfort);
    return this.planAt(sx, sy, tx, ty, c, out, heading, turnRadius);
  }

  /** One plan at clearance `c` (adds to {@link expanded}). */
  private planAt(sx: number, sy: number, tx: number, ty: number, c: number, out: Float64Array, heading: number, turnRadius: number): number {
    const coarse = this.coarse!;
    if (this.segmentClear(sx, sy, tx, ty, c) && !this.turnsInTight(sx, sy, tx, ty, this.full, heading, turnRadius)) {
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
    const headed = turnRadius > 0 && Number.isFinite(heading);
    const coarseOnly = headed && this.full > FINE_NAV_REACH;
    let cLen = 1, partial = false, gx = tx, gy = ty;
    this.cPath[0] = cs;
    if (cs !== cg && (coarseOnly || !inside(tx, ty))) {
      coarse.clearance = c;
      this.cGoal.map = coarse; this.cGoal.target = cg;
      let graph: SearchGraph = coarse, from = cs, shift = 0;
      if (headed) {
        this.headed.map = coarse; this.headed.turnRadius = turnRadius; this.headed.turnClear = this.full;
        this.headed.turnRoom45 = c < this.full ? navTurnRoom(this.full, this.beam, Math.SQRT1_2, Math.SQRT1_2) : 0;
        graph = this.headed; from = this.headed.startNode(cs, heading); shift = HEADING_NODE_SHIFT;
      }
      this.cGoal.shift = shift;
      let hit = this.search.search(graph, from, this.cGoal, NAV_COARSE_EXPAND_CAP);
      this.expanded += this.search.expanded;
      if (hit < 0) {
        // No way: head for the reached cell nearest the goal, if nearer than here.
        hit = this.search.nearest;
        if (hit < 0 || hit >> shift === cs) return 0;
        partial = true; gx = coarse.bestX[hit >> shift]!; gy = coarse.bestY[hit >> shift]!;
      }
      cLen = this.search.hops(hit) + 1;
      if (this.cPath.length < cLen) this.cPath = new Int32Array(cLen * 2);
      for (let t = hit, k = cLen - 1; k >= 0; t = this.search.prev(t), k--) this.cPath[k] = t >> shift;
    }
    // Coarse polyline: start, the inner cells' best points, goal (in `poly` for now).
    this.polyLen = 0;
    this.push(sx, sy);
    for (let k = 1; k < cLen - 1; k++) this.push(coarse.bestX[this.cPath[k]!]!, coarse.bestY[this.cPath[k]!]!);
    this.push(gx, gy);
    if (coarseOnly) {
      // A capital: the coarse way is its route (fine rock within its reach blocks it anyway).
      if (this.polyLen <= 2 && !partial && cs === cg) { out[0] = tx; out[1] = ty; this.status = 'none'; return 0; }
      const count = this.pull(this.polyLen, c, out, heading, turnRadius);
      this.status = partial ? 'nearest' : 'route';
      return count;
    }
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
    const count = this.pull(len, c, out, heading, turnRadius);
    this.status = partial ? 'nearest' : 'route';
    return count;
  }

  /** Would flying straight at (tx, ty) turn the ship more than 45° where it
   *  has no room to turn (slice 11)? Then the straight answer is not taken. */
  private turnsInTight(sx: number, sy: number, tx: number, ty: number, c: number, heading: number, turnRadius: number): boolean {
    if (!Number.isFinite(heading)) return false;
    return this.turnsInTightDir(sx, sy, tx, ty, c, -Math.sin(heading), Math.cos(heading), turnRadius);
  }

  /** As {@link turnsInTight}, for an arrival direction (hx, hy) (unit). */
  private turnsInTightDir(sx: number, sy: number, tx: number, ty: number, c: number, hx: number, hy: number, turnRadius: number): boolean {
    if (!(turnRadius > 0) || this.roomAt(sx, sy) >= c + turnRadius) return false;
    const dx = tx - sx, dy = ty - sy, d = Math.sqrt(dx * dx + dy * dy);
    return d > 1e-6 && (hx * dx + hy * dy) / d < Math.SQRT1_2 - 1e-9;
  }

  /** String-pull the first `len` points of `poly`: keep only the turns a
   *  straight line can't skip; writes the points after the start to `out`.
   *  With a turning radius (slice 11) a shortcut from a point with no room to
   *  turn may not swing more than 45° off the way the ship arrives there. */
  private pull(len: number, c: number, out: Float64Array, heading: number, turnRadius: number): number {
    const Q = this.poly, max = out.length >> 1, cf = this.comfort;
    const headed = turnRadius > 0 && Number.isFinite(heading);
    let hx = headed ? -Math.sin(heading) : 0, hy = headed ? Math.cos(heading) : 0;
    let a = 0, count = 0;
    while (a < len - 1 && count < max) {
      const ax = Q[a * 2]!, ay = Q[a * 2 + 1]!;
      let j = a + 1;
      // Does the unpulled path a..j keep `comfort`? While it does, a shortcut must too.
      let roomy = cf > c && this.segmentClear(ax, ay, Q[j * 2]!, Q[j * 2 + 1]!, cf);
      while (j + 1 < len) {
        // Where the path doubles back (in open space, the only place the search
        // turns round) the ship turns there: a shortcut past it would hide that.
        if (headed && j > a && this.doublesBack(j)) break;
        const bx = Q[(j + 1) * 2]!, by = Q[(j + 1) * 2 + 1]!;
        if (roomy) roomy = this.segmentClear(Q[j * 2]!, Q[j * 2 + 1]!, bx, by, cf);
        if (!this.segmentClear(ax, ay, bx, by, roomy ? cf : c) ||
          (headed && this.turnsInTightDir(ax, ay, bx, by, this.full, hx, hy, turnRadius))) break;
        j++;
      }
      const bx = Q[j * 2]!, by = Q[j * 2 + 1]!;
      out[count * 2] = bx; out[count * 2 + 1] = by;
      count++;
      if (headed) { const l = Math.hypot(bx - ax, by - ay); if (l > 1e-6) { hx = (bx - ax) / l; hy = (by - ay) / l; } }
      a = j;
    }
    return count;
  }

  /** Beam pass: does each turn of the route (the nose onto the first leg,
   *  then each corner) have the room the hull's sweep takes for its angle,
   *  along the arc's run-in and run-out (turnRadius · tan(θ/2) each side)? */
  private turnsFit(sx: number, sy: number, out: Float64Array, n: number, heading: number, turnRadius: number, beam: number): boolean {
    let px = sx, py = sy, hx = -Math.sin(heading), hy = Math.cos(heading), inLen = 0;
    for (let k = 0; k < n; k++) {
      const bx = out[k * 2]!, by = out[k * 2 + 1]!, l = Math.hypot(bx - px, by - py);
      if (l < 1e-6) continue;
      const ux = (bx - px) / l, uy = (by - py) / l;
      const cos = Math.max(-1, Math.min(1, hx * ux + hy * uy)), sin = Math.sqrt(1 - cos * cos);
      const need = navTurnRoom(this.full, beam, sin, cos);
      if (need > beam && !(k > 0 && cos < 0 && this.openAhead(px, py, hx, hy))) {
        const run = cos > -1 + 1e-9 ? (turnRadius * sin) / (1 + cos) : Infinity; // turnRadius · tan(θ/2)
        const o = Math.min(l, run), i = Math.min(inLen, run);
        if (!this.segmentClear(px, py, px + ux * o, py + uy * o, need)) return false;
        if (i > 0 && !this.segmentClear(px - hx * i, py - hy * i, px, py, need)) return false;
      }
      hx = ux; hy = uy; inLen = l; px = bx; py = by;
    }
    return true;
  }

  /** The last pass found no way at all (a method, so the status isn't narrowed across passes). */
  private failed(): boolean { return this.status === 'none'; }

  /** Does `poly` turn more than 90° at point j (the way in from the last
   *  distinct point before it, the way out to the next distinct one after)? */
  private doublesBack(j: number): boolean {
    const Q = this.poly, n = this.polyLen, jx = Q[j * 2]!, jy = Q[j * 2 + 1]!;
    let i = j - 1, k = j + 1;
    while (i >= 0 && Math.abs(Q[i * 2]! - jx) + Math.abs(Q[i * 2 + 1]! - jy) < 1e-6) i--;
    while (k < n && Math.abs(Q[k * 2]! - jx) + Math.abs(Q[k * 2 + 1]! - jy) < 1e-6) k++;
    if (i < 0 || k >= n) return false;
    return (jx - Q[i * 2]!) * (Q[k * 2]! - jx) + (jy - Q[i * 2 + 1]!) * (Q[k * 2 + 1]! - jy) < 0;
  }

  /** A corner past 90° (a hairpin at a lane's mouth): the ship overshoots it
   *  and turns round in the space beyond, so it fits when a coarse cell with
   *  room to turn round (not `tight`, as the coarse search judged it) lies
   *  within two cells ahead of the corner along the way in. */
  private openAhead(px: number, py: number, hx: number, hy: number): boolean {
    const m = this.coarse!, d = m.cell;
    for (let s = 0; s <= 2; s++) {
      const cell = m.cellAt(px + hx * d * s, py + hy * d * s);
      if (cell >= 0 && !this.headed.tight(cell)) return true;
    }
    return false;
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
