import { describe, it, expect } from 'vitest';
import { compareArms, mannWhitneyP, median, type RunMetrics } from './verdict';

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

  it('a clear, large slowdown is RED', () => {
    const v = compareArms([2, 2.1, 1.9, 2, 2.05].map((t) => run(t)), [4, 4.2, 3.9, 4.1, 4].map((t) => run(t)));
    expect(v.status).toBe('RED');
    expect(v.rows.find((r) => r.metric === 'serverTickP95')!.status).toBe('RED');
  });

  it('noise inside the thresholds is GREEN, and an improvement never fails', () => {
    expect(compareArms([2, 2.1, 1.9, 2].map((t) => run(t)), [2.1, 2.2, 2, 2.1].map((t) => run(t))).status).toBe('GREEN');
    expect(compareArms([4, 4, 4, 4].map((t) => run(t)), [2, 2, 2, 2].map((t) => run(t))).status).toBe('GREEN');
  });

  it('a big ratio on a tiny absolute move is GREEN (the AND rule)', () => {
    expect(compareArms([0.1, 0.1, 0.1, 0.1].map((t) => run(t)), [0.3, 0.3, 0.3, 0.3].map((t) => run(t))).status).toBe('GREEN');
  });

  it('too few valid runs is INVALID, never GREEN', () => {
    const bad: RunMetrics = { valid: false, timing: {}, counts: {}, raw: null };
    expect(compareArms([run(2), bad, bad], [run(2), run(2), run(2)]).status).toBe('INVALID');
  });
});
