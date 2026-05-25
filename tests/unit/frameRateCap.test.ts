/**
 * Internal 60 Hz work-loop cap — regression lock.
 *
 * Plan: `i-d-like-you-to-quirky-hartmanis.md` (render-jitter-chain-trigger).
 *
 * The cap exists to neutralise the 90 Hz native chain trigger documented in
 * captures `q4wtht` (90 Hz, spiraled) vs `d3cprl` (60 Hz, smooth). These
 * tests pin the per-refresh-rate cadence behaviour so:
 *
 *   - 60 Hz devices NEVER skip (the cap must not penalise the baseline that
 *     the user already accepted as smooth);
 *   - 90 Hz devices skip alternate RAFs (~45 Hz processed, less work than the
 *     60 Hz baseline);
 *   - 120 Hz devices skip alternate RAFs (~60 Hz processed);
 *   - 30 Hz thermal-throttled devices NEVER skip (we already can't keep up).
 *
 * The simulation mirrors the App.tsx loop's contract: caller passes the
 * elapsed `deltaMs` since the last PROCESSED frame (NOT since the last RAF),
 * so a skip leaves `lastFrameTime` stale and the next RAF's `deltaMs` is the
 * full wall-clock gap.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MIN_FRAME_INTERVAL_MS,
  shouldSkipFrame,
} from '../../src/client/perf/frameRateCap';

/**
 * Simulate the App.tsx RAF loop's interaction with `shouldSkipFrame` over a
 * stream of evenly-spaced native RAFs. Returns the count of frames the cap
 * processed vs skipped, and the effective processed rate (Hz).
 */
function simulate(opts: {
  nativePeriodMs: number;
  durationMs: number;
  minIntervalMs: number;
}): { processed: number; skipped: number; processedHz: number } {
  let lastFrameTime = 0;
  let processed = 0;
  let skipped = 0;

  const rafCount = Math.floor(opts.durationMs / opts.nativePeriodMs);
  for (let i = 0; i < rafCount; i++) {
    const now = i * opts.nativePeriodMs;
    const isFirstFrame = lastFrameTime === 0;
    const deltaMs = isFirstFrame ? 1000 / 60 : now - lastFrameTime;
    if (shouldSkipFrame(deltaMs, opts.minIntervalMs, isFirstFrame)) {
      skipped++;
      // Critical: do NOT update lastFrameTime on skip.
    } else {
      processed++;
      lastFrameTime = now;
    }
  }
  const seconds = opts.durationMs / 1000;
  return { processed, skipped, processedHz: processed / seconds };
}

describe('shouldSkipFrame — pure decision', () => {
  it('never skips on the first frame regardless of deltaMs', () => {
    expect(shouldSkipFrame(0, DEFAULT_MIN_FRAME_INTERVAL_MS, true)).toBe(false);
    expect(shouldSkipFrame(5, DEFAULT_MIN_FRAME_INTERVAL_MS, true)).toBe(false);
    expect(shouldSkipFrame(1000, DEFAULT_MIN_FRAME_INTERVAL_MS, true)).toBe(false);
  });

  it('skips when deltaMs is below the cap interval (10 ms post-2026-05-24)', () => {
    expect(shouldSkipFrame(8.33, DEFAULT_MIN_FRAME_INTERVAL_MS, false)).toBe(true);
    expect(shouldSkipFrame(9.99, DEFAULT_MIN_FRAME_INTERVAL_MS, false)).toBe(true);
  });

  it('processes when deltaMs equals or exceeds the cap interval (10 ms post-2026-05-24)', () => {
    expect(shouldSkipFrame(10.0, DEFAULT_MIN_FRAME_INTERVAL_MS, false)).toBe(false);
    expect(shouldSkipFrame(11.11, DEFAULT_MIN_FRAME_INTERVAL_MS, false)).toBe(false);
    expect(shouldSkipFrame(16.67, DEFAULT_MIN_FRAME_INTERVAL_MS, false)).toBe(false);
    expect(shouldSkipFrame(22.22, DEFAULT_MIN_FRAME_INTERVAL_MS, false)).toBe(false);
  });
});

describe('shouldSkipFrame — cadence simulation', () => {
  it('60 Hz native: no skips, processed rate = 60 Hz', () => {
    const r = simulate({
      nativePeriodMs: 1000 / 60,
      durationMs: 1000,
      minIntervalMs: DEFAULT_MIN_FRAME_INTERVAL_MS,
    });
    expect(r.skipped).toBe(0);
    expect(r.processedHz).toBeGreaterThanOrEqual(59);
    expect(r.processedHz).toBeLessThanOrEqual(61);
  });

  it('90 Hz native: processes every RAF, processed rate ≈ 90 Hz (cap=10, 2026-05-24)', () => {
    // Pre-2026-05-24 the cap was 15 ms, which throttled 90 Hz devices to
    // ~45 Hz processed. Probe 1 on capture `3vzz3q` proved per-RAF work
    // was ~1 ms with 14 ms headroom, so the historical thermal-cascade
    // concern no longer binds. Cap lowered to 10 ms; 90 Hz devices now
    // process every RAF. See `frameRateCap.realCapture.test.ts` for the
    // device-grounded validation against capture `4qm14l`.
    const r = simulate({
      nativePeriodMs: 1000 / 90,
      durationMs: 1000,
      minIntervalMs: DEFAULT_MIN_FRAME_INTERVAL_MS,
    });
    expect(r.skipped).toBe(0);
    expect(r.processedHz).toBeGreaterThanOrEqual(89);
    expect(r.processedHz).toBeLessThanOrEqual(91);
  });

  it('120 Hz native: alternates skip/process, processed rate ≈ 60 Hz', () => {
    const r = simulate({
      nativePeriodMs: 1000 / 120,
      durationMs: 1000,
      minIntervalMs: DEFAULT_MIN_FRAME_INTERVAL_MS,
    });
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.processedHz).toBeGreaterThanOrEqual(59);
    expect(r.processedHz).toBeLessThanOrEqual(61);
  });

  it('30 Hz post-thermal: no skips, processed rate = 30 Hz', () => {
    const r = simulate({
      nativePeriodMs: 1000 / 30,
      durationMs: 1000,
      minIntervalMs: DEFAULT_MIN_FRAME_INTERVAL_MS,
    });
    expect(r.skipped).toBe(0);
    expect(r.processedHz).toBeGreaterThanOrEqual(29);
    expect(r.processedHz).toBeLessThanOrEqual(31);
  });

  it('DEFAULT_MIN_FRAME_INTERVAL_MS sits between the 120 Hz period (8.3 ms) and the 90 Hz period (11.1 ms)', () => {
    // Above ~11 ms would re-throttle 90 Hz devices to ~45 fps (the bug
    // we fixed). Below ~8.3 ms would cease to bind 120 Hz devices.
    // 10 ms is the only value that throttles 120 Hz without penalising
    // 90 Hz.
    expect(DEFAULT_MIN_FRAME_INTERVAL_MS).toBeGreaterThan(8.3);
    expect(DEFAULT_MIN_FRAME_INTERVAL_MS).toBeLessThan(11.1);
  });
});
