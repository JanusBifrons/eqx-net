import { describe, it, expect } from 'vitest';
import {
  ASTEROID_YIELD, asteroidYield, asteroidYieldWeightPerUnit, oreRow, yieldHasGoods, yieldInto,
} from './asteroidResources.js';
import { GOOD_DEFS } from './goods.js';

describe('asteroidYield (shared extractor rule)', () => {
  it('rock gives minerals, ice gives ice, crystal-veined rock gives both', () => {
    expect(asteroidYield('rock', 30)).toEqual({ minerals: 30 });
    expect(asteroidYield('ice', 30)).toEqual({ ice: 30 });
    expect(asteroidYield('crystal', 30)).toEqual({ minerals: 24, crystal: 6 });
  });

  it('never yields more units than it drew', () => {
    for (const r of ['rock', 'ice', 'crystal'] as const) {
      for (const n of [0, 1, 7, 13, 60]) {
        const total = Object.values(asteroidYield(r, n)).reduce((a, b) => a + (b ?? 0), 0);
        expect(total).toBeLessThanOrEqual(n);
      }
    }
  });

  it('yieldInto matches asteroidYield for every kind and reuses its record', () => {
    const out = {};
    for (const r of ['rock', 'ice', 'crystal'] as const) {
      for (const n of [0, 1, 7, 13, 60]) {
        const got = yieldInto(ASTEROID_YIELD[r], n, out);
        expect(got).toBe(out);
        const nonZero = Object.fromEntries(Object.entries(got).filter(([, v]) => v !== 0));
        expect(nonZero).toEqual(asteroidYield(r, n));
      }
    }
  });

  it('oreRow: plain rock is all minerals, a rich spot is mostly ore', () => {
    expect(asteroidYield(oreRow({ ice: 0, crystal: 0 }, {}), 30)).toEqual({ minerals: 30 });
    expect(asteroidYield(oreRow({ ice: 1, crystal: 0 }, {}), 30)).toEqual({ ice: 30 });
    expect(asteroidYield(oreRow({ ice: 0, crystal: 0.2 }, {}), 30)).toEqual(asteroidYield('crystal', 30));
    const mixed = asteroidYield(oreRow({ ice: 0.5, crystal: 0.3 }, {}), 100);
    expect(mixed.ice).toBeGreaterThan(mixed.crystal ?? 0);
    expect((mixed.minerals ?? 0) + (mixed.ice ?? 0) + (mixed.crystal ?? 0)).toBeLessThanOrEqual(100);
    // Over-full shares are scaled down, never past 10.
    const row = oreRow({ ice: 1, crystal: 1 }, {});
    expect((row.ice ?? 0) + (row.crystal ?? 0)).toBeCloseTo(10);
    expect(row.minerals).toBe(0);
    expect(yieldHasGoods(oreRow({ ice: 0, crystal: 0 }, {}))).toBe(false);
    expect(yieldHasGoods(oreRow({ ice: 0.1, crystal: 0 }, {}))).toBe(true);
  });

  it('weight per unit matches the yield', () => {
    expect(asteroidYieldWeightPerUnit('rock')).toBeCloseTo(GOOD_DEFS.minerals.weight);
    expect(asteroidYieldWeightPerUnit('crystal')).toBeCloseTo(0.8 * GOOD_DEFS.minerals.weight + 0.2 * GOOD_DEFS.crystal.weight);
  });
});
