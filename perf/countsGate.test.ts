import { describe, it, expect } from 'vitest';
import { judgeCounts, calibrate, MIN_COUNT_FRAMES } from './countsGate.js';

const budget = { drawCallsP95: 100, displayObjects: 2000, uploadTexels: 4_194_304, atlasPages: 6, measured: 'test' };
const ok = { drawCallsP95: 80, displayObjects: 1500, uploadTexels: 0, atlasPages: 4, frames: 200 };

describe('client count gate', () => {
  it('within every budget: no failures', () => {
    expect(judgeCounts(ok, budget)).toEqual([]);
  });

  it('an extra draw call per frame over the budget fails, and says which', () => {
    const f = judgeCounts({ ...ok, drawCallsP95: 101 }, budget);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/drawCallsP95 101 over the 100 budget/);
  });

  it('reports every broken budget at once', () => {
    expect(judgeCounts({ ...ok, displayObjects: 2001, atlasPages: 7 }, budget)).toHaveLength(2);
  });

  it('too few rendered frames is an invalid run, never a pass', () => {
    expect(judgeCounts({ ...ok, frames: MIN_COUNT_FRAMES - 1 }, budget)[0]).toMatch(/invalid/);
  });

  it('calibrate: max + 25 %, rounded up, floored', () => {
    expect(calibrate([80, 92, 88])).toBe(115);
    expect(calibrate([0, 0, 0])).toBe(1);
    expect(calibrate([0], 4_194_304)).toBe(4_194_304);
  });
});
