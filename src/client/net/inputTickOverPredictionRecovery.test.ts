/**
 * Unit lock for the perf-floor session 3 hotfix — symmetric counterpart
 * to inputTickRecovery.test.ts.
 *
 * Symptom captured in `diag/captures/2026-05-20T22-47-58-606Z-ers7xy`:
 * sustained mobile burst-transit growing the server's input queue depth
 * unbounded; `inputTick - ackedTick` climbs from 6 (steady state) to
 * 327 (end of session). Each subsequent snapshot replays up to
 * BUFFER_SIZE=128 ticks of physics, saturating the mobile main thread
 * (rafP50 = 88.8 ms = 11 fps). The user perceives this as "ship
 * unresponsive" + visual frame-rate collapse.
 *
 * Fix: snap inputTick BACK to (ackedTick + leadTicks) when the gap
 * exceeds MAX_TICKS_AHEAD. Mirrors hotfix #2 (starvation, snap forward)
 * with the trigger condition reversed.
 */
import { describe, it, expect } from 'vitest';
import {
  recoverInputTickFromOverPrediction,
  MAX_TICKS_AHEAD,
} from './inputTickOverPredictionRecovery.js';

describe('inputTickOverPredictionRecovery', () => {
  it('returns inputTick unchanged when client is healthily ahead', () => {
    // Steady state: ticksAhead = leadTicks (~5-25)
    expect(recoverInputTickFromOverPrediction(120, 110, 10)).toBe(120);
  });

  it('returns inputTick unchanged at the exact threshold boundary (still healthy)', () => {
    // ticksAhead = MAX_TICKS_AHEAD exactly — still allowed.
    // The check is `> MAX_TICKS_AHEAD` (exclusive), not `>=`.
    const inputTick = 110 + MAX_TICKS_AHEAD;
    expect(recoverInputTickFromOverPrediction(inputTick, 110, 5)).toBe(inputTick);
  });

  it('snaps inputTick back when ticksAhead exceeds MAX_TICKS_AHEAD by 1', () => {
    // Just past the cap — snap to ackedTick + leadTicks.
    const inputTick = 110 + MAX_TICKS_AHEAD + 1;
    const recovered = recoverInputTickFromOverPrediction(inputTick, 110, 5);
    expect(recovered).toBe(115); // 110 + 5
  });

  it('snaps inputTick back from a deep over-prediction (the pathology)', () => {
    // ers7xy diagnostic numbers: ackedTick=2990, inputTick≈3317 (327 ahead),
    // leadTicks=25. Recovered = 2990 + 25 = 3015.
    expect(recoverInputTickFromOverPrediction(3317, 2990, 25)).toBe(3015);
  });

  it('respects the leadTicks parameter when snapping back', () => {
    const inputTick = 1000;
    const ackedTick = 800; // 200 ahead — past cap
    expect(recoverInputTickFromOverPrediction(inputTick, ackedTick, 10)).toBe(810);
    expect(recoverInputTickFromOverPrediction(inputTick, ackedTick, 5)).toBe(805);
    expect(recoverInputTickFromOverPrediction(inputTick, ackedTick, 25)).toBe(825);
  });

  it('does NOT fire when ticksAhead is negative (starvation case — let the OTHER recovery handle it)', () => {
    // The starvation recovery (inputTickRecovery.ts) handles inputTick <
    // ackedTick. This module deliberately ignores that case.
    expect(recoverInputTickFromOverPrediction(100, 110, 5)).toBe(100);
  });

  it('handles small leadTicks at threshold without crashing', () => {
    const inputTick = 110 + MAX_TICKS_AHEAD + 1;
    expect(recoverInputTickFromOverPrediction(inputTick, 110, 1)).toBe(111);
    expect(recoverInputTickFromOverPrediction(inputTick, 110, 0)).toBe(110);
  });

  it('MAX_TICKS_AHEAD is 50 — well above steady-state ticksAhead (~25 = CEILING_TICKS)', () => {
    // Lock the threshold. Steady-state ticksAhead is bounded by
    // CEILING_TICKS=30 (lookaheadController); 50 leaves ~25 ticks of
    // headroom for short bursts before triggering, while remaining
    // safely below the spiral-replay regression lock's <60 threshold.
    expect(MAX_TICKS_AHEAD).toBe(50);
  });
});
