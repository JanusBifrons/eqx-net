import { describe, it, expect } from 'vitest';
import { compareArms, mannWhitneyP, median, minAchievableP, noiseFloor, type RunMetrics } from './verdict';

const run = (tick: number, frame = 16.7): RunMetrics => ({ valid: true, timing: { serverTickP95: tick, clientFrameP95: frame }, counts: {}, raw: null });

describe('perf verdict', () => {
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('Mann-Whitney: fully separated 5 v 5 is p ≈ 0.008; identical is 1', () => {
    expect(mannWhitneyP([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])).toBeCloseTo(2 / 252, 4);
    expect(mannWhitneyP([5, 5, 5], [5, 5, 5])).toBe(1);
  });

  it('minimum achievable p: 3 v 3 can never reach 0.05, 4 v 4 can', () => {
    expect(minAchievableP(3, 3)).toBeCloseTo(0.1, 6);
    expect(minAchievableP(3, 4)).toBeCloseTo(2 / 35, 6);
    expect(minAchievableP(4, 4)).toBeCloseTo(2 / 70, 6);
    // The bound matches the exact test on fully separated samples.
    expect(mannWhitneyP([1, 2, 3], [4, 5, 6])).toBeCloseTo(minAchievableP(3, 3), 6);
    expect(mannWhitneyP([1, 2, 3, 4], [5, 6, 7, 8])).toBeCloseTo(minAchievableP(4, 4), 6);
  });

  it('a clear, large slowdown is RED', () => {
    const v = compareArms([2, 2.1, 1.9, 2, 2.05].map((t) => run(t)), [4, 4.2, 3.9, 4.1, 4].map((t) => run(t)));
    expect(v.status).toBe('RED');
    expect(v.rows.find((r) => r.metric === 'serverTickP95')!.status).toBe('RED');
  });

  it('3 v 3 fully separated far past the threshold is INCONCLUSIVE, never GREEN (2026-11-08)', () => {
    const v = compareArms([2, 2.1, 1.9].map((t) => run(t)), [8, 8.2, 7.9].map((t) => run(t)));
    expect(v.status).toBe('INCONCLUSIVE');
    const row = v.rows.find((r) => r.metric === 'serverTickP95')!;
    expect(row.status).toBe('INCONCLUSIVE');
    expect(row.note).toMatch(/can never reach/);
    // Even identical 3 v 3 arms are not GREEN: they could not have failed.
    expect(compareArms([2, 2, 2].map((t) => run(t)), [2, 2, 2].map((t) => run(t))).status).toBe('INCONCLUSIVE');
  });

  it('4 v 4 fully separated beyond the threshold is RED', () => {
    const v = compareArms([2, 2.1, 1.9, 2].map((t) => run(t)), [8, 8.2, 7.9, 8.1].map((t) => run(t)));
    expect(v.status).toBe('RED');
    expect(v.rows.find((r) => r.metric === 'serverTickP95')!.p).toBeCloseTo(0.03, 2);
  });

  it('identical arms at n ≥ 4 are GREEN', () => {
    expect(compareArms([2, 2, 2, 2].map((t) => run(t)), [2, 2, 2, 2].map((t) => run(t))).status).toBe('GREEN');
  });

  it('over the threshold but not significant is INCONCLUSIVE', () => {
    // Medians move ×2 but the ranks overlap heavily.
    const v = compareArms([2, 9, 2, 9, 2, 9].map((t) => run(t)), [9, 2, 9, 2, 9, 9.5].map((t) => run(t)));
    const row = v.rows.find((r) => r.metric === 'serverTickP95')!;
    expect(row.status).toBe('INCONCLUSIVE');
    expect(v.status).toBe('INCONCLUSIVE');
  });

  it('noise inside the thresholds is GREEN, and an improvement never fails', () => {
    expect(compareArms([2, 2.1, 1.9, 2].map((t) => run(t)), [2.1, 2.2, 2, 2.1].map((t) => run(t))).status).toBe('GREEN');
    expect(compareArms([4, 4, 4, 4].map((t) => run(t)), [2, 2, 2, 2].map((t) => run(t))).status).toBe('GREEN');
  });

  it('a big ratio on a tiny absolute move is GREEN (the AND rule)', () => {
    expect(compareArms([0.1, 0.1, 0.1, 0.1].map((t) => run(t)), [0.3, 0.3, 0.3, 0.3].map((t) => run(t))).status).toBe('GREEN');
  });

  it('noise floor: a move inside the A/A spread cannot be RED and says so', () => {
    const base = [2, 2.1, 1.9, 2].map((t) => run(t));
    const head = [3.2, 3.3, 3.1, 3.2].map((t) => run(t)); // ×1.6, p 0.03: RED without a floor
    expect(compareArms(base, head).status).toBe('RED');
    const aa = [3.4, 3.5, 3.3, 3.4].map((t) => run(t)); // same code read ×1.7 apart
    expect(noiseFloor(base, aa)['serverTickP95']).toBeCloseTo(1.7, 2);
    const v = compareArms(base, head, { noise: aa });
    const row = v.rows.find((r) => r.metric === 'serverTickP95')!;
    expect(row.status).toBe('INCONCLUSIVE');
    expect(row.note).toBe('within host noise (×1.7)');
    expect(v.status).toBe('INCONCLUSIVE');
    // A move well beyond the floor still goes RED.
    expect(compareArms(base, [8, 8.2, 7.9, 8.1].map((t) => run(t)), { noise: aa }).status).toBe('RED');
  });

  it('too few valid runs is INVALID, never GREEN', () => {
    const bad: RunMetrics = { valid: false, timing: {}, counts: {}, raw: null };
    expect(compareArms([run(2), bad, bad], [run(2), run(2), run(2)]).status).toBe('INVALID');
  });
});
