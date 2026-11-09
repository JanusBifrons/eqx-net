import { describe, it, expect } from 'vitest';
import { asteroidYield, asteroidYieldWeightPerUnit } from './asteroidResources.js';
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

  it('weight per unit matches the yield', () => {
    expect(asteroidYieldWeightPerUnit('rock')).toBeCloseTo(GOOD_DEFS.minerals.weight);
    expect(asteroidYieldWeightPerUnit('crystal')).toBeCloseTo(0.8 * GOOD_DEFS.minerals.weight + 0.2 * GOOD_DEFS.crystal.weight);
  });
});
