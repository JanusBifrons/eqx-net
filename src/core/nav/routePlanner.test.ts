import { describe, it, expect } from 'vitest';
import { RoutePlanner, NAV_ROUTE_MAX_POINTS, NAV_COARSE_EXPAND_CAP, NAV_FINE_EXPAND_CAP } from './routePlanner.js';
import { CoarseFieldMap } from './coarseField.js';
import { FineFieldLayer, FINE_NAV_CELL } from './fineField.js';
import { GraphSearch, type SearchGoal, type SearchGraph } from './search.js';
import { CHUNK_SIZE, SLICED, rocksInChunk, type ChunkOpts } from '../terrain/fieldLayout.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { fieldRockBody } from '../terrain/chunkStreamer.js';

const fighter = getShipKind('fighter').radius;
const battleship = getShipKind('battleship').radius;
const opts: ChunkOpts = { seed: 'look', battleshipLength: battleship * 2, fighterLength: fighter * 2 };

/** A busy chunk inside the field, off the lanes (as the fine layer's tests). */
function busyChunk(): { cx: number; cy: number } {
  for (let cx = 6; cx < 30; cx++) if (rocksInChunk(opts, cx, 3).length > 80) return { cx, cy: 3 };
  throw new Error('no busy chunk');
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

/** Smallest room met along the route, sampled every 8 u. */
function minRoomAlong(p: RoutePlanner, sx: number, sy: number, out: Float64Array, n: number): number {
  let min = Infinity, x = sx, y = sy;
  for (let k = 0; k < n; k++) {
    const bx = out[k * 2]!, by = out[k * 2 + 1]!, len = Math.hypot(bx - x, by - y);
    for (let t = 0; t <= len; t += 8) min = Math.min(min, p.roomAt(x + ((bx - x) * t) / len, y + ((by - y) * t) / len));
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

/** Points with room for a fighter either side of the chunk's biggest rock (the line through it blocked). */
function acrossARock(p: RoutePlanner, coarse: CoarseFieldMap, fine: FineFieldLayer, cx: number, cy: number): { sx: number; sy: number; tx: number; ty: number } {
  // Seed the planner's layers with a throwaway straight request.
  p.plan(coarse, fine, cx * CHUNK_SIZE, cy * CHUNK_SIZE, cx * CHUNK_SIZE, cy * CHUNK_SIZE, 0, new Float64Array(2));
  const rocks = rocksInChunk(opts, cx, cy).map(fieldRockBody).sort((a, b) => b.radius - a.radius);
  for (const r of rocks) {
    for (let d = r.radius + 200; d < r.radius + 1500; d += 100) {
      const sx = r.x - d, sy = r.y, tx = r.x + d, ty = r.y;
      if (p.roomAt(sx, sy) >= fighter && p.roomAt(tx, ty) >= fighter && !p.segmentClear(sx, sy, tx, ty, fighter)) return { sx, sy, tx, ty };
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
    expect(minRoomAlong(p, sx, sy, out, n)).toBeGreaterThanOrEqual(fighter - 1e-6);
    // Lower bound: the 8-way grid path over the same cells is at most 1.0824× the true shortest.
    const ox = (at.cx - 2) * CHUNK_SIZE, oy = (at.cy - 2) * CHUNK_SIZE, w = (5 * CHUNK_SIZE) / FINE_NAV_CELL;
    const ref = new RefGrid(ox, oy, w, (x, y) => p.roomAt(x, y), fighter);
    const cell = (x: number, y: number) => Math.floor((y - oy) / FINE_NAV_CELL) * w + Math.floor((x - ox) / FINE_NAV_CELL);
    const target = cell(tx, ty);
    const goal: SearchGoal = { isGoal: (i) => i === target, heuristic: (i) => Math.hypot(ref.x(i) - tx, ref.y(i) - ty) * 0.999 };
    const s = new GraphSearch(), hit = s.search(ref, cell(sx, sy), goal);
    expect(hit).toBe(target);
    const lower = s.cost(hit) / 1.0824 - 2 * FINE_NAV_CELL; // cell centres vs the exact ends
    const len = routeLength(sx, sy, out, n);
    console.log(`[nav route] fighter round a rock: ${n} waypoints, ${len.toFixed(0)} u (grid ${s.cost(hit).toFixed(0)} u), ` +
      `${p.expanded} expansions, ${ms.toFixed(1)} ms`);
    expect(len).toBeLessThanOrEqual(1.2 * lower);
    // Repeat: same answer, no growth.
    const again = new Float64Array(out.length);
    expect(p.plan(coarse, fine, sx, sy, tx, ty, fighter, again)).toBe(n);
    expect(Array.from(again)).toEqual(Array.from(out));
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

  it('no way at this clearance (goal inside a rock) ⇒ none, within the expansion caps', () => {
    const at = busyChunk();
    const { coarse, fine } = world(at);
    const p = new RoutePlanner(), out = new Float64Array(NAV_ROUTE_MAX_POINTS * 2);
    const rock = rocksInChunk(opts, at.cx, at.cy).map(fieldRockBody).sort((a, b) => b.radius - a.radius)[0]!;
    acrossARock(p, coarse, fine, at.cx, at.cy);
    expect(p.roomAt(rock.x, rock.y)).toBe(0);
    let sx = rock.x - rock.radius - 300;
    while (p.roomAt(sx, rock.y) < fighter) sx -= 64;
    expect(p.plan(coarse, fine, sx, rock.y, rock.x, rock.y, fighter, out)).toBe(0);
    expect(p.status).toBe('none');
    expect(p.expanded).toBeGreaterThan(0);
    expect(p.expanded).toBeLessThanOrEqual(NAV_COARSE_EXPAND_CAP + NAV_FINE_EXPAND_CAP);
  });
});
