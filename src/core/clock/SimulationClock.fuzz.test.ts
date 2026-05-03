import { describe, it, expect } from 'vitest';
import {
  SimulationClock,
  TIDI_FLOOR,
  TIDI_CEIL,
  WINDOW_TICKS,
  RAMP_PER_TICK,
} from './SimulationClock.js';

/**
 * Fuzz: random over/under-budget reports must not produce oscillation.
 * The 30-tick hysteresis is the load-bearing invariant. If it breaks, this
 * test will surface either out-of-range rates or a high-frequency oscillation
 * pattern in the autocorrelation at lag 30.
 */

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return (): number => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe('SimulationClock fuzz', () => {
  it('rate stays in [FLOOR, CEIL] for 10000 random reports', () => {
    const rand = mulberry32(0x42424242);
    const c = new SimulationClock();
    for (let i = 0; i < 10000; i++) {
      const ms = 8 + rand() * 12; // [8, 20)
      c.report(ms);
      expect(c.rate).toBeGreaterThanOrEqual(TIDI_FLOOR);
      expect(c.rate).toBeLessThanOrEqual(TIDI_CEIL);
    }
  });

  it('within any WINDOW_TICKS window the target rate flips at most once', () => {
    const rand = mulberry32(0xdeadbeef);
    const c = new SimulationClock();
    let lastTarget = c.targetRate;
    let flipsInWindow = 0;
    let ticksSinceFlip = WINDOW_TICKS;
    for (let i = 0; i < 5000; i++) {
      const ms = 8 + rand() * 12;
      c.report(ms);
      ticksSinceFlip += 1;
      if (c.targetRate !== lastTarget) {
        if (ticksSinceFlip < WINDOW_TICKS) flipsInWindow += 1;
        lastTarget = c.targetRate;
        ticksSinceFlip = 0;
      }
    }
    // Hysteresis means each target-flip costs WINDOW_TICKS of opposite-sign
    // reports — so two flips inside a single window is impossible.
    expect(flipsInWindow).toBe(0);
  });

  it('rate changes are bounded by RAMP_PER_TICK per step', () => {
    const rand = mulberry32(0xc0ffee);
    const c = new SimulationClock();
    let prev = c.rate;
    for (let i = 0; i < 5000; i++) {
      const ms = 8 + rand() * 12;
      c.report(ms);
      expect(Math.abs(c.rate - prev)).toBeLessThanOrEqual(RAMP_PER_TICK + 1e-9);
      prev = c.rate;
    }
  });
});
