import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AiNeighbourGrid, NEIGHBOUR_CELL_SEPARATIONS } from './AiNeighbourGrid.js';
import { GLOBAL_SHIP_TUNING } from '../../shared-types/shipScale/lookup.js';

interface Pt { x: number; y: number }

function build(grid: AiNeighbourGrid, pts: readonly Pt[]): void {
  grid.begin();
  pts.forEach((p, i) => {
    if (i % 3 === 0) grid.addPilot(`p${i}`, p.x, p.y, 0, 0, 10);
    else grid.addDrone(`d${i}`, p.x, p.y, 1, -1, 12, i % 3 === 1 ? 'drones' : 'robots');
  });
  grid.end();
}

/** Brute force: indices within r, nearest first, ties by lower index. */
function brute(pts: readonly Pt[], x: number, y: number, r: number, k: number, skip = -1): number[] {
  const c: Array<{ i: number; d2: number }> = [];
  pts.forEach((p, i) => {
    if (i === skip) return;
    const dx = p.x - x, dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r * r) c.push({ i, d2 });
  });
  c.sort((a, b) => a.d2 - b.d2 || a.i - b.i);
  return c.slice(0, k).map((e) => e.i);
}

describe('AiNeighbourGrid', () => {
  it('cell size follows the fighter separation (shipTuning, #18)', () => {
    expect(new AiNeighbourGrid().cell).toBe(NEIGHBOUR_CELL_SEPARATIONS * GLOBAL_SHIP_TUNING.flockSeparation);
  });

  it('matches a brute-force K-nearest scan (property)', () => {
    const coord = fc.double({ min: -5000, max: 5000, noNaN: true });
    fc.assert(fc.property(
      fc.array(fc.record({ x: coord, y: coord }), { maxLength: 120 }),
      coord, coord,
      fc.double({ min: 0, max: 4000, noNaN: true }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 50, max: 900 }),
      (pts, x, y, r, k, cell) => {
        const g = new AiNeighbourGrid(cell);
        build(g, pts);
        const out = new Int32Array(16);
        const n = g.queryNeighbours(x, y, r, k, out);
        expect(Array.from(out.subarray(0, n))).toEqual(brute(pts, x, y, r, k));
      },
    ), { numRuns: 300 });
  });

  it('orders K nearest by distance, ties by lower index', () => {
    const g = new AiNeighbourGrid(100);
    const pts = [{ x: 30, y: 0 }, { x: 10, y: 0 }, { x: -10, y: 0 }, { x: 0, y: 20 }, { x: 500, y: 0 }];
    build(g, pts);
    const out = new Int32Array(8);
    const n = g.queryNeighbours(0, 0, 100, 3, out);
    expect(Array.from(out.subarray(0, n))).toEqual([1, 2, 3]);
  });

  it('finds entries across cell borders and exactly on a border', () => {
    const g = new AiNeighbourGrid(100);
    // 99.999 and 100 sit in different cells; -0.001 in a negative cell.
    const pts = [{ x: 99.999, y: 0 }, { x: 100, y: 0 }, { x: -0.001, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }];
    build(g, pts);
    const out = new Int32Array(8);
    const n = g.queryNeighbours(100, 0, 100, 8, out);
    expect(Array.from(out.subarray(0, n))).toEqual(brute(pts, 100, 0, 100, 8));
    expect(n).toBe(4);
    // r exactly reaches an entry: inclusive.
    expect(g.queryNeighbours(0, 0, 200, 8, out)).toBe(brute(pts, 0, 0, 200, 8).length);
  });

  it('a wide query (beyond the cell window) scans all and still agrees', () => {
    const g = new AiNeighbourGrid(10);
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: (i * 997) % 3000 - 1500, y: (i * 613) % 3000 - 1500 }));
    build(g, pts);
    const out = new Int32Array(8);
    const n = g.queryNeighbours(0, 0, 5000, 8, out);
    expect(Array.from(out.subarray(0, n))).toEqual(brute(pts, 0, 0, 5000, 8));
  });

  it('excludeId skips the caller', () => {
    const g = new AiNeighbourGrid(100);
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 9, y: 0 }];
    build(g, pts);
    const out = new Int32Array(8);
    const n = g.queryNeighbours(0, 0, 50, 8, out, 'p0');
    expect(Array.from(out.subarray(0, n))).toEqual(brute(pts, 0, 0, 50, 8, 0));
  });

  it('clamps K to the out buffer and exposes entry fields', () => {
    const g = new AiNeighbourGrid(100);
    build(g, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
    const out = new Int32Array(2);
    expect(g.queryNeighbours(0, 0, 50, 8, out)).toBe(2);
    expect(g.isPilotAt(0)).toBe(true);
    expect(g.sideAt(0)).toBe('players');
    expect(g.sideAt(1)).toBe('drones');
    expect(g.sideAt(2)).toBe('robots');
    expect(g.idAt(1)).toBe('d1');
    expect([g.vxAt(1), g.vyAt(1), g.radiusAt(1)]).toEqual([1, -1, 12]);
  });

  it('rebuild reuses buffers: no growth across same-size rebuilds', () => {
    const g = new AiNeighbourGrid();
    const pts = Array.from({ length: 200 }, (_, i) => ({ x: i * 37, y: -i * 11 }));
    build(g, pts);
    const cap = g.capacity;
    expect(cap).toBeGreaterThanOrEqual(200);
    for (let t = 0; t < 5; t++) build(g, pts);
    expect(g.capacity).toBe(cap);
    expect(g.count).toBe(200);
  });

  it('counts queries per rebuild window', () => {
    const g = new AiNeighbourGrid();
    build(g, [{ x: 0, y: 0 }]);
    const out = new Int32Array(4);
    g.queryNeighbours(0, 0, 10, 4, out);
    g.queryNeighbours(0, 0, 10, 4, out);
    expect(g.queriesThisTick).toBe(2);
    build(g, [{ x: 0, y: 0 }]);
    expect(g.lastTickQueries).toBe(2);
    expect(g.queriesThisTick).toBe(0);
    expect(g.queriesTotal).toBe(2);
  });
});
