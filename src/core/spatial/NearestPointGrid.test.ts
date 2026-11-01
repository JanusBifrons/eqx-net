/**
 * NearestPointGrid must return exactly what the linear scan it replaces
 * returned (turret targeting, plan soft-leaping-truffle v2 A1): same winner,
 * including exact ties (the last-added equal point wins) and the inclusive
 * range edge.
 */
import { describe, expect, it } from 'vitest';
import { NearestPointGrid } from './NearestPointGrid.js';

function brute(xs: number[], ys: number[], x: number, y: number, range: number): number {
  let best = -1;
  let bestD2 = range * range;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - x, dy = ys[i]! - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0) / 4294967296);
}

describe('NearestPointGrid', () => {
  it('matches the linear scan on 20 000 random queries (incl. points outside the extent)', () => {
    const r = rng(9);
    const g = new NearestPointGrid(512, 10_000, 4);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const x = (r() - 0.5) * 24_000, y = (r() - 0.5) * 24_000; // some beyond ±10 000
      xs.push(x); ys.push(y); g.add(x, y);
    }
    g.build();
    for (let q = 0; q < 20_000; q++) {
      const x = (r() - 0.5) * 22_000, y = (r() - 0.5) * 22_000, range = 50 + r() * 2500;
      expect(g.nearest(x, y, range)).toBe(brute(xs, ys, x, y, range));
    }
  });

  it('exact ties go to the point added last; the range edge is inclusive', () => {
    const g = new NearestPointGrid(512, 10_000);
    g.add(100, 0); // d = 100
    g.add(-100, 0); // d = 100, added later → wins
    g.add(0, 300); // exactly on a 300 range edge
    g.build();
    expect(g.nearest(0, 0, 150)).toBe(1);
    const h = new NearestPointGrid(512, 10_000);
    h.add(0, 300);
    h.build();
    expect(h.nearest(0, 0, 300)).toBe(0);
    expect(h.nearest(0, 0, 299.99)).toBe(-1);
  });

  it('reset + rebuild reuses the grid; empty grid returns -1', () => {
    const g = new NearestPointGrid(256, 5000);
    expect(g.nearest(0, 0, 1000)).toBe(-1);
    g.add(10, 10); g.build();
    expect(g.nearest(0, 0, 100)).toBe(0);
    g.reset(); g.add(500, 500); g.build();
    expect(g.nearest(0, 0, 100)).toBe(-1);
    expect(g.nearest(480, 480, 100)).toBe(0);
  });
});

describe('NearestPointGrid — op-count lock (turret targeting budget)', () => {
  it('a turret-range query examines only a few percent of the sector (vs 100 % for the old scan)', () => {
    const g = new NearestPointGrid(512, 10_000);
    for (let i = 0; i < 2000; i++) g.add(((i * 7919) % 20_000) - 10_000, ((i * 104_729) % 20_000) - 10_000);
    g.build();
    let worst = 0;
    for (let q = 0; q < 200; q++) {
      g.nearest(((q * 331) % 16_000) - 8000, ((q * 577) % 16_000) - 8000, 900);
      worst = Math.max(worst, g.lastVisited);
    }
    // Range 900 covers ≤ 5×5 cells of 512 u ≈ 1.6 % of the 40×40 grid.
    expect(worst).toBeLessThanOrEqual(2000 * 0.05);
  });
});
