import { describe, it, expect } from 'vitest';
import { RoutePlanner, NAV_ROUTE_MAX_POINTS, NAV_COARSE_EXPAND_CAP, NAV_FINE_EXPAND_CAP } from './routePlanner.js';
import { CoarseFieldMap } from './coarseField.js';
import { FineFieldLayer, FINE_NAV_CELL, FINE_NAV_REACH } from './fineField.js';
import { GraphSearch, type SearchGoal, type SearchGraph } from './search.js';
import { CHUNK_SIZE, SLICED, rocksInChunk, slicedFieldLanes, type ChunkOpts } from '../terrain/fieldLayout.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { fieldRockBody } from '../terrain/chunkStreamer.js';
import { HeadingCoarseGraph } from './coarseField.js';
import { makePilotHandling, pilotTurnRadius } from '../ai/virtualPilot.js';
import { shipBodyMass, shipTuning } from '../../shared-types/shipScale/tuning.js';
import { navComfort, navBeamClearance } from '../../shared-types/shipScale/navTuning.js';

const fighter = getShipKind('fighter').radius;
const battleship = getShipKind('battleship').radius;
const opts: ChunkOpts = { seed: 'look', battleshipLength: battleship * 2, fighterLength: fighter * 2 };

/** A sparse chunk inside the field (38 rocks): room between them for a fighter.
 *  The busy chunks are packed solid; fighters cross those by street. */
function busyChunk(): { cx: number; cy: number } {
  expect(rocksInChunk(opts, 20, 10).length).toBeGreaterThan(20);
  return { cx: 20, cy: 10 };
}

function world(loadAround?: { cx: number; cy: number }): { coarse: CoarseFieldMap; fine: FineFieldLayer } {
  const coarse = new CoarseFieldMap();
  coarse.build(opts);
  const fine = new FineFieldLayer(opts);
  if (loadAround) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) fine.chunkLoaded(loadAround.cx + dx, loadAround.cy + dy);
  return { coarse, fine };
}

function routeLength(sx: number, sy: number, out: Float64Array, n: number): number {
  let len = 0, x = sx, y = sy;
  for (let k = 0; k < n; k++) { len += Math.hypot(out[k * 2]! - x, out[k * 2 + 1]! - y); x = out[k * 2]!; y = out[k * 2 + 1]!; }
  return len;
}

/** Smallest room met along the route, sampled every 8 u: the cell bound, or
 *  for a hull of clearance `c` the exact room where the bound can't tell. */
function minRoomAlong(p: RoutePlanner, sx: number, sy: number, out: Float64Array, n: number, c = 0): number {
  let min = Infinity, x = sx, y = sy;
  for (let k = 0; k < n; k++) {
    const bx = out[k * 2]!, by = out[k * 2 + 1]!, len = Math.hypot(bx - x, by - y);
    for (let t = 0; t <= len; t += 8) {
      const px = x + ((bx - x) * t) / len, py = y + ((by - y) * t) / len, r = p.roomAt(px, py);
      min = Math.min(min, r < c && p.tight(px, py, c) ? p.exactRoom(px, py, c) : r);
    }
    x = bx; y = by;
  }
  return min;
}

/** Reference: plain 8-way A* over 64 u cells of a block, cells with room >= c. */
class RefGrid implements SearchGraph {
  nodeCount: number;
  constructor(readonly ox: number, readonly oy: number, readonly w: number, readonly room: (x: number, y: number) => number, readonly c: number) {
    this.nodeCount = w * w;
  }
  x(i: number): number { return this.ox + ((i % this.w) + 0.5) * FINE_NAV_CELL; }
  y(i: number): number { return this.oy + (((i / this.w) | 0) + 0.5) * FINE_NAV_CELL; }
  edgeCount(): number { return 8; }
  edgeTo(i: number, k: number): number {
    const gx = (i % this.w) + [1, -1, 0, 0, 1, 1, -1, -1][k]!, gy = ((i / this.w) | 0) + [0, 0, 1, -1, 1, -1, 1, -1][k]!;
    if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.w) return i;
    const j = gy * this.w + gx;
    return this.room(this.x(j), this.y(j)) >= this.c ? j : i;
  }
  edgeCost(_i: number, k: number): number { return k < 4 ? FINE_NAV_CELL : FINE_NAV_CELL * Math.SQRT2; }
}

/** The reference grid path over the 5×5 chunks round (cx, cy), or null when none fits a fighter. */
function refPath(p: RoutePlanner, cx: number, cy: number, sx: number, sy: number, tx: number, ty: number): { cost: number } | null {
  const ox = (cx - 2) * CHUNK_SIZE, oy = (cy - 2) * CHUNK_SIZE, w = (5 * CHUNK_SIZE) / FINE_NAV_CELL;
  const ref = new RefGrid(ox, oy, w, (x, y) => p.roomAt(x, y), fighter);
  const cell = (x: number, y: number) => Math.floor((y - oy) / FINE_NAV_CELL) * w + Math.floor((x - ox) / FINE_NAV_CELL);
  const target = cell(tx, ty);
  const goal: SearchGoal = { isGoal: (i) => i === target, heuristic: (i) => Math.hypot(ref.x(i) - tx, ref.y(i) - ty) * 0.999 };
  const s = new GraphSearch(), hit = s.search(ref, cell(sx, sy), goal);
  return hit === target ? { cost: s.cost(hit) } : null;
}

/** Points with room for a fighter either side of the chunk's biggest rock (the line through it blocked). */
function acrossARock(p: RoutePlanner, coarse: CoarseFieldMap, fine: FineFieldLayer, cx: number, cy: number): { sx: number; sy: number; tx: number; ty: number } {
  // Seed the planner's layers with a throwaway straight request.
  p.plan(coarse, fine, cx * CHUNK_SIZE, cy * CHUNK_SIZE, cx * CHUNK_SIZE, cy * CHUNK_SIZE, 0, new Float64Array(2));
  const rocks = rocksInChunk(opts, cx, cy).map(fieldRockBody).sort((a, b) => b.radius - a.radius);
  for (const r of rocks) {
    for (let d = r.radius + 200; d < r.radius + 1500; d += 100) {
      const sx = r.x - d, sy = r.y, tx = r.x + d, ty = r.y;
      if (p.roomAt(sx, sy) >= 3 * fighter && p.roomAt(tx, ty) >= 3 * fighter && !p.segmentClear(sx, sy, tx, ty, fighter) &&
        refPath(p, cx, cy, sx, sy, tx, ty) !== null) return { sx, sy, tx, ty };
    }
  }
  throw new Error('no blocked crossing');
}

describe('RoutePlanner (straight check, coarse A*, fine window A*, string-pull)', () => {
  it('a clear straight line is the route: one waypoint, no search', () => {
    const { coarse, fine } = world();
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    const far = SLICED.radius * 1.3;
    expect(p.plan(coarse, fine, far, 0, far, 20_000, fighter, out)).toBe(1);
    expect(p.status).toBe('straight');
    expect(p.expanded).toBe(0);
    expect([out[0], out[1]]).toEqual([far, 20_000]);
  });

  it('a fighter goes round a rock: every leg clear, length near the grid optimum (prints expansions + ms)', () => {
    const at = busyChunk();
    const { coarse, fine } = world(at);
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    const { sx, sy, tx, ty } = acrossARock(p, coarse, fine, at.cx, at.cy);
    const t0 = performance.now();
    const n = p.plan(coarse, fine, sx, sy, tx, ty, fighter, out);
    const ms = performance.now() - t0;
    expect(p.status).toBe('route');
    expect(n).toBeGreaterThan(1);
    expect([out[(n - 1) * 2], out[(n - 1) * 2 + 1]]).toEqual([tx, ty]);
    expect(minRoomAlong(p, sx, sy, out, n, fighter)).toBeGreaterThanOrEqual(fighter - 2);
    // Lower bound: the 8-way grid path over the same cells is at most 1.0824× the true shortest.
    const grid = refPath(p, at.cx, at.cy, sx, sy, tx, ty)!.cost;
    const lower = grid / 1.0824 - 2 * FINE_NAV_CELL; // cell centres vs the exact ends
    const len = routeLength(sx, sy, out, n);
    console.log(`[nav route] fighter round a rock: ${n} waypoints, ${len.toFixed(0)} u (grid ${grid.toFixed(0)} u), ` +
      `${p.expanded} expansions, ${ms.toFixed(1)} ms`);
    expect(len).toBeLessThanOrEqual(1.2 * lower);
    // Repeat: same answer, no growth.
    const again = new Float64Array(out.length);
    expect(p.plan(coarse, fine, sx, sy, tx, ty, fighter, again)).toBe(n);
    expect(Array.from(again)).toEqual(Array.from(out));
  });

  it('a fighter crosses a packed chunk by its street: exact room along the route, within the exact-query gate', () => {
    // Packed chunk (-9, 5): every 64 u cell bound closes its streets (gaps pinch to
    // 60-68 u, fighter clearance 30), so before the exact refinement (fine rebuild
    // slice A) this was 'nearest'. Ends 300 u inside the chunk's west and east edges.
    const at = { cx: -9, cy: 5 }, c = shipTuning(getShipKind('fighter')).navClearance;
    const { coarse, fine } = world(at);
    const sx = at.cx * CHUNK_SIZE + 300, sy = 23_404, tx = (at.cx + 1) * CHUNK_SIZE - 300, ty = 20_812;
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    const q0 = fine.exactQueries, t0 = performance.now();
    const n = p.plan(coarse, fine, sx, sy, tx, ty, c, out);
    const ms = performance.now() - t0, queries = fine.exactQueries - q0;
    const built = fine.liveCount, bytes = fine.poolBytes;
    console.log(`[nav route] fighter across packed chunk: ${n} waypoints, ${p.expanded} expansions, ${queries} exact queries, ` +
      `${built}/${fine.loadedCount} loaded chunks built (${(bytes / 1024).toFixed(0)} KB of the pool), ${ms.toFixed(1)} ms`);
    expect(p.status).toBe('route');
    expect([out[(n - 1) * 2], out[(n - 1) * 2 + 1]]).toEqual([tx, ty]);
    // Every point of the route, every 2 u, has the exact room (less the trace's shortest step).
    let x = sx, y = sy, min = Infinity;
    for (let k = 0; k < n; k++) {
      const bx = out[k * 2]!, by = out[k * 2 + 1]!, len = Math.hypot(bx - x, by - y);
      for (let t = 0; t <= len; t += 2) min = Math.min(min, fine.exactAt(x + ((bx - x) * t) / len, y + ((by - y) * t) / len, FINE_NAV_REACH));
      x = bx; y = by;
    }
    expect(min).toBeGreaterThanOrEqual(c - 2);
    // Count gate (measured 25 452 locally, 2026-11-18; raise only on a new measurement).
    expect(queries).toBeLessThanOrEqual(32_000);
    // On demand: detail only for the chunks the search reached (measured 2 of 25, 100 KB).
    expect(built).toBeLessThanOrEqual(4);
    expect(p.expanded).toBeLessThanOrEqual(NAV_COARSE_EXPAND_CAP + NAV_FINE_EXPAND_CAP);
  });

  it('comfort (owner 2026-11-19): round a rock the route keeps the shield clear; a packed street falls back to clearance', () => {
    const t = shipTuning(getShipKind('fighter')), c = t.navClearance, cf = navComfort(getShipKind('fighter'));
    expect(cf).toBeGreaterThan(c);
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    // Round a rock in a sparse chunk: room for the shield, so the route keeps it.
    const at = busyChunk(), w = world(at);
    const { sx, sy, tx, ty } = acrossARock(p, w.coarse, w.fine, at.cx, at.cy);
    const n = p.plan(w.coarse, w.fine, sx, sy, tx, ty, c, out, NaN, 0, cf);
    expect(p.status).toBe('route');
    expect([out[(n - 1) * 2], out[(n - 1) * 2 + 1]]).toEqual([tx, ty]);
    expect(minRoomAlong(p, sx, sy, out, n, cf)).toBeGreaterThanOrEqual(cf - 2);
    // Packed chunk (-9, 5): its street pinches below the shield (no plan at 44 u gets through),
    // so the plan squeezes down to the clearance: the same route as without comfort.
    const st = { cx: -9, cy: 5 }, v = world(st);
    const ax = st.cx * CHUNK_SIZE + 300, ay = 23_404, bx = (st.cx + 1) * CHUNK_SIZE - 300, by = 20_812;
    const m = p.plan(v.coarse, v.fine, ax, ay, bx, by, c, out);
    const plain = Array.from(out.subarray(0, m * 2));
    expect(p.plan(v.coarse, v.fine, ax, ay, bx, by, c, out, NaN, 0, cf)).toBe(m);
    expect(p.status).toBe('route');
    expect(Array.from(out.subarray(0, m * 2))).toEqual(plain);
  });

  it('a fighter flies round a structure in open space (a static obstacle, not a rock)', () => {
    const { coarse, fine } = world();
    const c = shipTuning(getShipKind('fighter')).navClearance;
    const x = 100.5 * CHUNK_SIZE, y = 0.5 * CHUNK_SIZE, hw = 150, hh = 600;
    fine.obstacleSet(1, { x, y, radius: Math.hypot(hw, hh), angle: 0, parts: [[{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }]] });
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    const sx = x - 1500, tx = x + 1500;
    const n = p.plan(coarse, fine, sx, y, tx, y, c, out);
    console.log(`[nav route] fighter round a structure: ${n} waypoints, ${p.expanded} expansions, status ${p.status}`);
    expect(p.status).toBe('route');
    expect(n).toBeGreaterThan(1); // not the straight line through it
    let px = sx, py = y, min = Infinity;
    for (let k = 0; k < n; k++) {
      const bx = out[k * 2]!, by = out[k * 2 + 1]!, len = Math.hypot(bx - px, by - py);
      for (let t = 0; t <= len; t += 2) min = Math.min(min, fine.exactAt(px + ((bx - px) * t) / len, py + ((by - py) * t) / len, FINE_NAV_REACH));
      px = bx; py = by;
    }
    expect(min).toBeGreaterThanOrEqual(c - 2);
    expect(p.expanded).toBeLessThanOrEqual(NAV_COARSE_EXPAND_CAP + NAV_FINE_EXPAND_CAP);
  });

  it('a battleship crossing the field keeps to wide space (lanes / round the outside), never a street', () => {
    const { coarse, fine } = world();
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    const R = SLICED.radius;
    const t0 = performance.now();
    const n = p.plan(coarse, fine, -R * 1.2, 0, R * 1.2, 0, battleship, out);
    const ms = performance.now() - t0;
    expect(p.status).toBe('route');
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(NAV_ROUTE_MAX_POINTS);
    // Streets are at most 576 u wide: nowhere along the route is that tight.
    const min = minRoomAlong(p, -R * 1.2, 0, out, n);
    console.log(`[nav route] battleship across the field: ${n} waypoints, ${routeLength(-R * 1.2, 0, out, n).toFixed(0)} u, ` +
      `min room ${min.toFixed(0)}, ${p.expanded} expansions, ${ms.toFixed(1)} ms`);
    expect(min).toBeGreaterThan(576);
  });

  it('no way to the goal (inside a rock) ⇒ nearest: a clear route to a point with room, nearer the goal, within the caps', () => {
    const at = busyChunk();
    const { coarse, fine } = world(at);
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    const rock = rocksInChunk(opts, at.cx, at.cy).map(fieldRockBody).sort((a, b) => b.radius - a.radius)[0]!;
    acrossARock(p, coarse, fine, at.cx, at.cy);
    expect(p.roomAt(rock.x, rock.y)).toBe(0);
    let sx = rock.x - rock.radius - 300;
    while (p.roomAt(sx, rock.y) < fighter) sx -= 64;
    sx -= 600; // a little way off, so there is somewhere nearer to go
    while (p.roomAt(sx, rock.y) < fighter) sx -= 64;
    const n = p.plan(coarse, fine, sx, rock.y, rock.x, rock.y, fighter, out);
    expect(p.status).toBe('nearest');
    expect(n).toBeGreaterThan(0);
    const ex = out[(n - 1) * 2]!, ey = out[(n - 1) * 2 + 1]!;
    expect(Math.hypot(ex - rock.x, ey - rock.y)).toBeLessThan(Math.hypot(sx - rock.x, 0) - 300);
    // The end is a cell node: its centre, or its roomiest exact sample (fine rebuild slice A).
    expect(p.roomAt(ex, ey) >= fighter || p.exactRoom(ex, ey, fighter) >= fighter).toBe(true);
    expect(minRoomAlong(p, sx, rock.y, out, n, fighter)).toBeGreaterThanOrEqual(fighter - 2);
    expect(p.expanded).toBeGreaterThan(0);
    expect(p.expanded).toBeLessThanOrEqual(NAV_COARSE_EXPAND_CAP + NAV_FINE_EXPAND_CAP);
  });
  it('a battleship in a lane with its goal behind it plans no U-turn there: it goes on forward (slice 11)', () => {
    const BS = getShipKind('battleship');
    const h = makePilotHandling(BS, shipBodyMass(BS));
    const turnR = pilotTurnRadius(h);
    const c = shipTuning(BS).navClearance;
    const { coarse, fine } = world();
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    // A lane cell: a capital fits, but with less room than it needs to turn round, and
    // the lane runs on both ways along one compass step.
    const NDX = [1, -1, 0, 0, 1, 1, -1, -1], NDY = [0, 0, 1, -1, 1, -1, 1, -1];
    const tight = (i: number) => coarse.room[i]! >= c && coarse.room[i]! < c + turnR;
    let found: { i: number; k: number } | null = null;
    for (let i = 0; i < coarse.cols * coarse.rows && found === null; i++) {
      if (!tight(i)) continue;
      const x = i % coarse.cols, y = (i / coarse.cols) | 0;
      for (let k = 0; k < 4 && found === null; k++) {
        const along = (n: number) => (y + NDY[k]! * n) * coarse.cols + x + NDX[k]! * n;
        if (tight(along(1)) && tight(along(2)) && tight(along(-1)) && tight(along(-2))) found = { i, k };
      }
    }
    expect(found, `no lane at turn radius ${turnR.toFixed(0)}`).not.toBeNull();
    const { i, k } = found!;
    const sx = coarse.bestX[i]!, sy = coarse.bestY[i]!;
    // Pointing along +k: ship angle a with (-sin a, cos a) = the step's direction.
    const heading = Math.atan2(-NDX[k]!, NDY[k]!);
    expect(HeadingCoarseGraph.stepOf(heading)).toBe([0, 4, 2, 6][k]);
    const tx = sx - NDX[k]! * 2 * 2048, ty = sy - NDY[k]! * 2 * 2048;
    // Without the heading: straight back down the lane.
    p.plan(coarse, fine, sx, sy, tx, ty, c, out);
    const plainFirst = Math.atan2(out[1]! - sy, out[0]! - sx);
    // With it: the first leg goes on forward (within 45° of the nose).
    const n = p.plan(coarse, fine, sx, sy, tx, ty, c, out, heading, turnR);
    console.log(`[nav route] battleship lane U-turn: turn radius ${turnR.toFixed(0)}, status ${p.status}, ${n} waypoints, ${p.expanded} expansions`);
    expect(['route', 'nearest']).toContain(p.status);
    const fx = out[0]! - sx, fy = out[1]! - sy, fl = Math.hypot(fx, fy);
    expect((fx * NDX[k]! + fy * NDY[k]!) / (fl * Math.hypot(NDX[k]!, NDY[k]!))).toBeGreaterThan(Math.SQRT1_2 - 1e-6);
    expect(Math.cos(plainFirst - Math.atan2(NDY[k]!, NDX[k]!))).toBeLessThan(0); // control: it did turn back
    // Across the whole field with its nose on: still a route, within the expansion cap.
    const R = 150_000 * 1.2, across = p.plan(coarse, fine, -R, 0, R, 0, c, out, -Math.PI / 2, turnR);
    console.log(`[nav route] battleship across the field, nose on: ${across} waypoints, ${p.expanded} expansions`);
    expect(p.status).toBe('route');
    expect(p.expanded).toBeLessThan(NAV_COARSE_EXPAND_CAP);
  });
  it('a battleship down a lane gets a way (owner 2026-11-19: its width on straights, its length only where it turns)', () => {
    const BS = getShipKind('battleship');
    const turnR = pilotTurnRadius(makePilotHandling(BS, shipBodyMass(BS)));
    const c = shipTuning(BS).navClearance;
    const { coarse, fine } = world();
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    const ln = slicedFieldLanes({ seed: opts.seed, battleshipLength: opts.battleshipLength })[0]!;
    const dx = ln.n.y, dy = -ln.n.x; // along the lane
    // On the lane's centre line inside the field, nose down the lane; the goal 12 km on.
    const at = (t: number) => ({ x: ln.o.x + dx * t, y: ln.o.y + dy * t });
    // Inside the field (the lane runs through its middle third), not out past its rim.
    let t0 = -6_000;
    p.plan(coarse, fine, 0, 0, 0, 0, c, out); // seed the planner's layers
    while (coarse.roomAt(at(t0).x, at(t0).y) < 2_000) t0 += 512;
    expect(Math.hypot(at(t0).x, at(t0).y)).toBeLessThan(SLICED.radius * 0.6);
    expect(coarse.roomAt(at(t0).x, at(t0).y)).toBeLessThan(c); // the old disc rule: no room
    const s = at(t0), g = at(t0 + 12_000);
    // The rock along the way streamed in, as in a live sector.
    for (let t = t0 - 4096; t <= t0 + 16_000; t += CHUNK_SIZE / 2) {
      const q = at(t), cx = Math.floor(q.x / CHUNK_SIZE), cy = Math.floor(q.y / CHUNK_SIZE);
      for (let ox = -2; ox <= 2; ox++) for (let oy = -2; oy <= 2; oy++) fine.chunkLoaded(cx + ox, cy + oy);
    }
    const heading = Math.atan2(-dx, dy);
    const n = p.plan(coarse, fine, s.x, s.y, g.x, g.y, c, out, heading, turnR, navComfort(BS), navBeamClearance(BS));
    console.log(`[nav route] battleship down a lane: start room ${coarse.roomAt(s.x, s.y).toFixed(0)} at (${s.x.toFixed(0)}, ${s.y.toFixed(0)}), status ${p.status}, ${n} waypoints, ${p.expanded} expansions`);
    expect(['straight', 'route']).toContain(p.status);
    const ex = out[(n - 1) * 2]!, ey = out[(n - 1) * 2 + 1]!;
    expect(Math.hypot(ex - g.x, ey - g.y)).toBeLessThan(1);
    // Its goal behind it: still no U-turn in the lane (no room to swing its length there).
    const back = at(t0 - 12_000), nb = p.plan(coarse, fine, s.x, s.y, back.x, back.y, c, out, heading, turnR, navComfort(BS), navBeamClearance(BS));
    console.log(`[nav route] battleship lane, goal behind (beam): status ${p.status}, ${nb} waypoints, ${p.expanded} expansions`);
    // A way (on along the lane and round), not 'none': a gap it fits only
    // straight through must not shut it out of the lane it can turn in.
    expect(['route', 'nearest']).toContain(p.status);
    expect(nb).toBeGreaterThan(0);
    const fx = out[0]! - s.x, fy = out[1]! - s.y;
    expect((fx * dx + fy * dy) / Math.hypot(fx, fy)).toBeGreaterThan(Math.SQRT1_2 - 1e-6);
    // Across the whole field, nose on: a route on the beam, its runs keeping the beam's room, within the cap.
    const R = SLICED.radius * 1.2, across = p.plan(coarse, fine, -R, 0, R, 0, c, out, -Math.PI / 2, turnR, navComfort(BS), navBeamClearance(BS));
    const len = routeLength(-R, 0, out, across), min = minRoomAlong(p, -R, 0, out, across);
    console.log(`[nav route] battleship across the field on its beam: ${across} waypoints, ${len.toFixed(0)} u, min room ${min.toFixed(0)}, ${p.expanded} expansions`);
    expect(p.status).toBe('route');
    expect(min).toBeGreaterThanOrEqual(navBeamClearance(BS) - FINE_NAV_CELL);
    expect(p.expanded).toBeLessThan(NAV_COARSE_EXPAND_CAP * 2);
  });
  it('a battleship\'s turns are checked against its length: no 90° turn or hairpin inside a lane, a hairpin past its mouth is fine', () => {
    const BS = getShipKind('battleship');
    const turnR = pilotTurnRadius(makePilotHandling(BS, shipBodyMass(BS)));
    const c = shipTuning(BS).navClearance, beam = navBeamClearance(BS);
    const { coarse, fine } = world();
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    const ln = slicedFieldLanes({ seed: opts.seed, battleshipLength: opts.battleshipLength })[0]!;
    const dx = ln.n.y, dy = -ln.n.x, heading = Math.atan2(-dx, dy);
    const at = (t: number) => ({ x: ln.o.x + dx * t, y: ln.o.y + dy * t });
    let t0 = -6_000;
    while (coarse.roomAt(at(t0).x, at(t0).y) < 2_000) t0 += 512;
    const s = at(t0), g = at(t0 + 12_000);
    const back = at(t0 - 12_000); // goal behind: a coarse heading search runs, seeding the layers and the heading graph
    p.plan(coarse, fine, s.x, s.y, back.x, back.y, c, out, heading, turnR, navComfort(BS), beam);
    const fits = (sx: number, sy: number, pts: { x: number; y: number }[]): boolean => {
      pts.forEach((q, k) => { out[k * 2] = q.x; out[k * 2 + 1] = q.y; });
      return (p as unknown as { turnsFit(sx: number, sy: number, o: Float64Array, n: number, h: number, r: number, b: number): boolean })
        .turnsFit(sx, sy, out, pts.length, heading, turnR, beam);
    };
    const mid = at(t0 + 6_000), side = { x: mid.x + ln.n.x * 3_000, y: mid.y + ln.n.y * 3_000 };
    expect(fits(s.x, s.y, [g])).toBe(true); // straight down the lane: its beam is enough
    expect(fits(s.x, s.y, [mid, side])).toBe(false); // 90° mid-lane: no room for its length
    expect(fits(s.x, s.y, [mid, s])).toBe(false); // hairpin mid-lane: no room to turn round ahead
    // Out past the field's rim along the lane: the hairpin turns round in open space.
    const R = SLICED.radius, a = at(R * 0.9), mouth = at(R * 1.12);
    expect(fits(a.x, a.y, [mouth, a])).toBe(true);
  });
});
