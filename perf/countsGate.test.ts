import { describe, it, expect } from 'vitest';
import { judgeCounts, calibrate, poolReadings, MIN_COUNT_FRAMES } from './countsGate.js';

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

  it('texture uploads are print-only: they depend on host speed, not the code', () => {
    // 2026-11-12: CI runners that drew 33-40 frames in the window uploaded 1-3
    // 2048² pages (art still baking after the curtain); runners at 52-57
    // uploaded 0-1, and the same PR locally 0. Three PRs went red on it.
    expect(judgeCounts({ ...ok, uploadTexels: 12_582_912 }, budget)).toEqual([]);
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

describe('poolReadings', () => {
  it('adds frames so two short runs make one valid reading', () => {
    const a = { ...ok, frames: 15 }, b = { ...ok, frames: 18 };
    expect(judgeCounts(a, budget).length).toBe(1);
    const p = poolReadings([a, b]);
    expect(p.frames).toBe(33);
    expect(judgeCounts(p, budget)).toEqual([]);
  });

  it('keeps the worst count, so pooling never hides an over-budget run', () => {
    const p = poolReadings([{ ...ok, frames: 15 }, { ...ok, drawCallsP95: 140, frames: 15 }]);
    expect(p.drawCallsP95).toBe(140);
    expect(judgeCounts(p, budget).some((l) => l.includes('drawCallsP95'))).toBe(true);
  });
});
