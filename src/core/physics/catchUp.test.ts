import { describe, it, expect } from 'vitest';
import { advanceSchedule, CATCH_UP_MAX_TICKS, type CatchUpResult } from './catchUp.js';

const T = 1000 / 60;

describe('advanceSchedule (worker catch-up cap)', () => {
  const out: CatchUpResult = { nextTickAt: 0, dropped: 0 };

  it('on schedule: next tick one step later, nothing dropped', () => {
    advanceSchedule(0, 0, T, out);
    expect(out.nextTickAt).toBeCloseTo(T);
    expect(out.dropped).toBe(0);
  });

  it('a backlog within the cap is replayed, not dropped', () => {
    advanceSchedule(CATCH_UP_MAX_TICKS * T, 0, T, out);
    expect(out.dropped).toBe(0);
    expect(out.nextTickAt).toBeCloseTo(T);
  });

  it('a long stall jumps to now and counts the ticks it skips', () => {
    // 1 s late: ~60 ticks were due; the schedule jumps and they are lost.
    advanceSchedule(1000, 0, T, out);
    expect(out.nextTickAt).toBeCloseTo(1000 + T);
    expect(out.dropped).toBe(Math.floor((1000 - T) / T));
    expect(out.dropped).toBeGreaterThanOrEqual(58);
  });
});
