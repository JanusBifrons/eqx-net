import { describe, it, expect } from 'vitest';
import {
  SimulationClock,
  TIDI_FLOOR,
  TIDI_CEIL,
  OVER_BUDGET_MS,
  WINDOW_TICKS,
  RAMP_PER_TICK,
} from './SimulationClock.js';
import { Bus } from '../events/Bus.js';

const OVER = OVER_BUDGET_MS + 1;
const UNDER = OVER_BUDGET_MS - 1;

describe('SimulationClock', () => {
  it('starts at rate 1.0', () => {
    const c = new SimulationClock();
    expect(c.rate).toBe(TIDI_CEIL);
    expect(c.targetRate).toBe(TIDI_CEIL);
  });

  it('does not change target before WINDOW_TICKS over-budget reports', () => {
    const c = new SimulationClock();
    for (let i = 0; i < WINDOW_TICKS - 1; i++) c.report(OVER);
    expect(c.targetRate).toBe(TIDI_CEIL);
    expect(c.rate).toBe(TIDI_CEIL);
  });

  it('flips target to FLOOR after exactly WINDOW_TICKS over-budget reports', () => {
    const c = new SimulationClock();
    for (let i = 0; i < WINDOW_TICKS; i++) c.report(OVER);
    expect(c.targetRate).toBe(TIDI_FLOOR);
    // Rate has stepped down by RAMP_PER_TICK each report after the threshold.
    // Threshold met on tick WINDOW_TICKS, so rate has moved one step down.
    expect(c.rate).toBeCloseTo(TIDI_CEIL - RAMP_PER_TICK, 6);
  });

  it('ramps rate toward FLOOR by RAMP_PER_TICK per report', () => {
    const c = new SimulationClock();
    for (let i = 0; i < WINDOW_TICKS; i++) c.report(OVER);
    const startRate = c.rate;
    c.report(OVER);
    expect(c.rate).toBeCloseTo(startRate - RAMP_PER_TICK, 6);
  });

  it('eventually pins at FLOOR after sustained over-budget', () => {
    const c = new SimulationClock();
    for (let i = 0; i < WINDOW_TICKS + 200; i++) c.report(OVER);
    expect(c.rate).toBeCloseTo(TIDI_FLOOR, 6);
  });

  it('reverses target back to 1.0 after WINDOW_TICKS of under-budget', () => {
    const c = new SimulationClock();
    for (let i = 0; i < WINDOW_TICKS + 200; i++) c.report(OVER);
    expect(c.targetRate).toBe(TIDI_FLOOR);

    for (let i = 0; i < WINDOW_TICKS; i++) c.report(UNDER);
    expect(c.targetRate).toBe(TIDI_CEIL);
  });

  it('resets consecutiveOver if a single under-budget tick lands mid-window', () => {
    const c = new SimulationClock();
    for (let i = 0; i < WINDOW_TICKS - 1; i++) c.report(OVER);
    c.report(UNDER); // breaks the streak
    for (let i = 0; i < WINDOW_TICKS - 1; i++) c.report(OVER);
    // Only WINDOW_TICKS-1 consecutive overs since the break → target unchanged.
    expect(c.targetRate).toBe(TIDI_CEIL);
  });

  it('emits TIDI_RATE_CHANGED on bus when rate crosses an epsilon step', () => {
    const bus = new Bus();
    const events: number[] = [];
    bus.on('TIDI_RATE_CHANGED', (e) => events.push(e.rate));
    const c = new SimulationClock(bus);

    // Below WINDOW_TICKS: no rate change → no emit.
    for (let i = 0; i < WINDOW_TICKS - 1; i++) c.report(OVER);
    expect(events.length).toBe(0);

    // Cross threshold: rate now stepping; each step ≥ RAMP_PER_TICK should emit.
    for (let i = 0; i < 5; i++) c.report(OVER);
    expect(events.length).toBeGreaterThan(0);
    // Each emit should be monotonic non-increasing.
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!).toBeLessThanOrEqual(events[i - 1]!);
    }
  });

  it('does not emit when rate is constant at the floor', () => {
    const bus = new Bus();
    const events: number[] = [];
    bus.on('TIDI_RATE_CHANGED', (e) => events.push(e.rate));
    const c = new SimulationClock(bus);
    // Drive to floor.
    for (let i = 0; i < WINDOW_TICKS + 200; i++) c.report(OVER);
    const emitsAtFloor = events.length;
    // Continue reporting over-budget at the floor — no further emits.
    for (let i = 0; i < 50; i++) c.report(OVER);
    expect(events.length).toBe(emitsAtFloor);
  });

  it('rate stays in [FLOOR, CEIL] under arbitrary inputs', () => {
    const c = new SimulationClock();
    for (let i = 0; i < 5000; i++) {
      const ms = i % 17 < 8 ? OVER : UNDER;
      c.report(ms);
      expect(c.rate).toBeGreaterThanOrEqual(TIDI_FLOOR);
      expect(c.rate).toBeLessThanOrEqual(TIDI_CEIL);
    }
  });
});
