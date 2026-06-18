import { describe, it, expect } from 'vitest';
import { interpBuildPct } from './buildBarInterp.js';

describe('interpBuildPct — smooth linear construction bar (Phase 1 issue 1)', () => {
  it('returns the anchor at elapsed 0', () => {
    expect(interpBuildPct(0.3, 8000, 0)).toBeCloseTo(0.3, 6);
  });

  it('ramps LINEARLY toward 1.0 over etaMs', () => {
    // From 0.5 with 8 s to go: halfway through (4 s) ⇒ halfway of the remaining
    // 0.5 ⇒ 0.75.
    expect(interpBuildPct(0.5, 8000, 4000)).toBeCloseTo(0.75, 6);
    // Equal sub-intervals advance by equal amounts (linearity).
    const a = interpBuildPct(0.0, 10000, 2000);
    const b = interpBuildPct(0.0, 10000, 4000);
    const c = interpBuildPct(0.0, 10000, 6000);
    expect(b - a).toBeCloseTo(c - b, 6);
  });

  it('reaches 1.0 at elapsed === etaMs and clamps beyond', () => {
    expect(interpBuildPct(0.2, 5000, 5000)).toBeCloseTo(1, 6);
    expect(interpBuildPct(0.2, 5000, 9999)).toBe(1);
  });

  it('FREEZES at the anchor when stalled (etaMs null/undefined)', () => {
    expect(interpBuildPct(0.42, null, 5000)).toBeCloseTo(0.42, 6);
    expect(interpBuildPct(0.42, undefined, 5000)).toBeCloseTo(0.42, 6);
    expect(interpBuildPct(0.42, 0, 5000)).toBeCloseTo(0.42, 6);
  });

  it('clamps the anchor itself to [0,1]', () => {
    expect(interpBuildPct(-0.1, null, 0)).toBe(0);
    expect(interpBuildPct(1.5, null, 0)).toBe(1);
  });
});
