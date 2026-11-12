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

describe('tickPeriodMs (ticks per wall second follow the game speed)', () => {
  it('1× is 60 Hz, 2× is 120 Hz, 0.5× is 30 Hz', async () => {
    const { tickPeriodMs } = await import('./catchUp.js');
    expect(tickPeriodMs(1)).toBeCloseTo(1000 / 60);
    expect(tickPeriodMs(2)).toBeCloseTo(1000 / 120);
    expect(tickPeriodMs(0.5)).toBeCloseTo(1000 / 30);
    expect(tickPeriodMs(0)).toBeCloseTo(1000 / 60);
    expect(tickPeriodMs(Number.NaN)).toBeCloseTo(1000 / 60);
  });
});
