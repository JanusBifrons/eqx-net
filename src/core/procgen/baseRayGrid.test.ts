/**
 * BaseRayGrid locks (plan: soft-leaping-truffle, PR-V2).
 *  - CORRECTNESS: matches a brute-force test against every outline segment
 *    for thousands of seeded random rays over a real max-size warehouse.
 *  - OP-COUNT budget: worst-case rays (straight across the base, diagonal,
 *    grazing along a row) visit a bounded number of cells/segments — the
 *    CPU proxy that stops weapon queries spiralling as bases grow.
 */
import { describe, expect, it } from 'vitest';
import { generateBase } from './generateBase.js';
import { BASE_GENERATOR_VERSION } from './baseLayout.js';
import { baseOutlineSegments } from './baseChunkMesh.js';
import { BaseRayGrid } from './baseRayGrid.js';
import { Rng } from './rng.js';
import { SHOWCASE_BASE_MAX_SIZE } from '../../shared-types/baseBudgets.js';

const layout = generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed: 9999, x: 700, y: -300, size: SHOWCASE_BASE_MAX_SIZE });
const grid = new BaseRayGrid();
grid.build(layout);
const local = baseOutlineSegments(layout);

function brute(ox: number, oy: number, dx: number, dy: number, maxDist: number): number {
  let best = -1;
  for (let i = 0; i < local.length; i += 4) {
    const ax = local[i]! + layout.descriptor.x, ay = local[i + 1]! + layout.descriptor.y;
    const ex = local[i + 2]! + layout.descriptor.x - ax, ey = local[i + 3]! + layout.descriptor.y - ay;
    const den = dx * ey - dy * ex;
    if (den === 0) continue;
    const qx = ax - ox, qy = ay - oy;
    const t = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
    if (t >= 0 && u >= 0 && u <= 1 && t <= maxDist && (best < 0 || t < best)) best = t;
  }
  return best;
}

describe('BaseRayGrid', () => {
  it('matches brute force for 5000 seeded random rays (incl. starting outside the base)', () => {
    const rng = new Rng(12345);
    const span = layout.half + 1500;
    for (let k = 0; k < 5000; k++) {
      const ox = layout.descriptor.x + rng.int(-span, span);
      const oy = layout.descriptor.y + rng.int(-span, span);
      const a = (rng.int(0, 35999) / 36000) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      const maxDist = rng.int(50, 12000);
      const want = brute(ox, oy, dx, dy, maxDist);
      const got = grid.rayFirst(ox, oy, dx, dy, maxDist);
      if (want < 0) expect(got, `ray ${k}`).toBe(-1);
      else expect(got, `ray ${k}`).toBeCloseTo(want, 6);
    }
  });

  it('axis-aligned rays work (zero dx or dy)', () => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ox = layout.descriptor.x - (dx !== 0 ? dx * (layout.half + 500) : 37);
      const oy = layout.descriptor.y - (dy !== 0 ? dy * (layout.half + 500) : 41);
      expect(grid.rayFirst(ox, oy, dx, dy, 20000)).toBeCloseTo(brute(ox, oy, dx, dy, 20000), 6);
    }
  });

  it('op-count budget: a worst-case ray across a max base stays bounded', () => {
    // Straight across, diagonal corner-to-corner, and through an aisle.
    const h = layout.half, x = layout.descriptor.x, y = layout.descriptor.y;
    const rays: Array<[number, number, number, number]> = [
      [x - h - 10, y + 1, 1, 0],
      [x - h - 10, y - h - 10, Math.SQRT1_2, Math.SQRT1_2],
      [x + 3, y - h - 10, 0, 1],
    ];
    let worstCells = 0, worstSegs = 0;
    for (const [ox, oy, dx, dy] of rays) {
      grid.rayFirst(ox, oy, dx, dy, 3 * h);
      worstCells = Math.max(worstCells, grid.lastCellsVisited);
      worstSegs = Math.max(worstSegs, grid.lastSegmentsTested);
    }
    // A ray stops at the first wall; even a full traversal of an 8000 u base
    // crosses ≤ 2·(5656/128) ≈ 90 cells. Segments tested stays a small
    // multiple of that. These bounds are the CPU budget for one weapon query.
    expect(worstCells).toBeLessThanOrEqual(100);
    expect(worstSegs).toBeLessThanOrEqual(400);
  });

  it('a ray that hits nothing within maxDist returns -1', () => {
    expect(grid.rayFirst(layout.descriptor.x + layout.half + 2000, layout.descriptor.y, 1, 0, 5000)).toBe(-1);
  });
});
