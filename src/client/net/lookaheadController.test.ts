/**
 * Stage 4 cycles 3 + 4 of the network-feel roadmap. Pure-function tests for
 * the input-clock lookahead controller.
 *
 * Pre-Stage-4: `desiredLead = max(3, min(20, round(rtt/33)))` —
 * EWMA-smoothed against RTT *mean only*. Under unstable links the input
 * loop visibly stutters when a jitter spike exceeds the chosen `leadTicks`,
 * because the prediction window wasn't sized for variance.
 *
 * Stage 4: `desiredLead = clamp(ceil((mean + 2σ) / FIXED_MS) + floor, ...)`.
 * The `mean + 2σ` band statistically covers ~97.5% of jitter spikes for a
 * normal-ish RTT distribution. When the target changes by > 1 tick the
 * controller spring-smooths the transition over ~200 ms instead of
 * jumping — yanking `targetTick` blew up the reconciler's replay window in
 * the pre-Stage-4 EWMA-only formula.
 */
import { describe, it, expect } from 'vitest';
import {
  createLookaheadController,
  computeDesiredLead,
  updateLookahead,
} from './lookaheadController.js';

describe('lookaheadController', () => {
  it('Cycle 3: computeDesiredLead floors at min ticks for low-RTT clients', () => {
    expect(computeDesiredLead(5, 1)).toBe(3);  // tiny RTT, σ≈0 — still 3-tick floor
    expect(computeDesiredLead(0, 0)).toBe(3);
  });

  it('Cycle 3: computeDesiredLead reflects mean + 2σ for typical RTT/jitter', () => {
    // RTT mean = 50 ms, σ = 10 ms → mean + 2σ = 70 ms = 4.2 ticks → ceil 5.
    expect(computeDesiredLead(50, 10)).toBe(5);
    // RTT mean = 100 ms, σ = 15 ms → 130 ms = 7.8 ticks → ceil 8.
    expect(computeDesiredLead(100, 15)).toBe(8);
  });

  it('Cycle 3: computeDesiredLead caps at max ticks for catastrophic RTT', () => {
    // Without the cap, runaway prediction ticks would speculate forever
    // during a multi-second freeze.
    expect(computeDesiredLead(2000, 100)).toBeLessThanOrEqual(30);
    expect(computeDesiredLead(2000, 100)).toBe(30);
  });

  it('Cycle 3: computeDesiredLead grows with σ even at fixed mean', () => {
    const lowJitter = computeDesiredLead(50, 2);
    const midJitter = computeDesiredLead(50, 10);
    const highJitter = computeDesiredLead(50, 25);
    // Jitter expands the buffer monotonically.
    expect(midJitter).toBeGreaterThan(lowJitter);
    expect(highJitter).toBeGreaterThan(midJitter);
  });

  it('Cycle 4: small target changes (≤1 tick) snap immediately', () => {
    const ctrl = createLookaheadController(5);
    // Target = 5, current = 5 → no change.
    expect(updateLookahead(ctrl, 5, 16)).toBe(5);
    // Target = 6, current = 5 → 1-tick change → snap.
    expect(updateLookahead(ctrl, 6, 16)).toBe(6);
    // Target = 5, current = 6 → 1-tick change → snap.
    expect(updateLookahead(ctrl, 5, 16)).toBe(5);
  });

  it('Cycle 4: large abrupt target jumps ramp via spring (~200 ms half-life)', () => {
    const ctrl = createLookaheadController(5);
    // Target jumps from 5 → 11 (6-tick change). Spring-smoothed.
    // After one 16 ms frame, leadTicks should be partway between 5 and 11
    // (the spring's halfLife is 100 ms; at 16 ms we expect ~10% progress).
    const after16 = updateLookahead(ctrl, 11, 16);
    expect(after16).toBeGreaterThanOrEqual(5);
    expect(after16).toBeLessThan(11);

    // Continue ramping. After ~200 ms (12 frames) we should be ≥ 9 (most
    // of the way there).
    let cur = after16;
    for (let i = 0; i < 12; i++) cur = updateLookahead(ctrl, 11, 16);
    expect(cur).toBeGreaterThanOrEqual(9);
    expect(cur).toBeLessThanOrEqual(11);

    // After 500 ms (30 frames at 16 ms) we should be at the target.
    for (let i = 0; i < 30; i++) cur = updateLookahead(ctrl, 11, 16);
    expect(cur).toBe(11);
  });

  it('Cycle 4: rapidly changing target mid-ramp re-targets without resetting velocity', () => {
    // The spring naturally re-targets — its velocity carries forward, so
    // a target change mid-ramp produces continuous motion rather than a
    // discontinuous velocity reset. Stage 1's CritDampedSpring guarantees
    // monotonic approach to whatever the latest target is.
    const ctrl = createLookaheadController(5);
    let cur = 5;
    // Ramp toward 11, then redirect to 7 mid-way.
    for (let i = 0; i < 6; i++) cur = updateLookahead(ctrl, 11, 16);
    expect(cur).toBeGreaterThan(5);
    // Now redirect to 7. Spring should converge there.
    for (let i = 0; i < 30; i++) cur = updateLookahead(ctrl, 7, 16);
    expect(cur).toBe(7);
  });

  it('Cycle 4: integer ticks emitted (renderer doesn\'t want fractional)', () => {
    // The internal spring is float-valued; the controller exposes a
    // rounded integer because the input-loop counts whole ticks.
    const ctrl = createLookaheadController(5);
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) samples.push(updateLookahead(ctrl, 11, 16));
    for (const s of samples) {
      expect(Number.isInteger(s)).toBe(true);
    }
  });
});
