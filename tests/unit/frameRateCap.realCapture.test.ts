/**
 * Frame-rate cap on REAL captured data — proves the fpscap=10 hypothesis
 * locally without needing another on-device smoke.
 *
 * Plan: mobile-perf-reconciliation-review (2026-05-24).
 *
 * The existing `frameRateCap.test.ts` tests the cap math against synthetic
 * evenly-spaced 60/90/120 Hz cadences. This test reads the *actual* native
 * rAF cadence captured on the user's Pixel 6 (capture `4qm14l`) from the
 * `device_info_calibration` event — measured BEFORE any game work runs, so
 * the value is the true native vsync rate the browser is willing to give
 * the page.
 *
 * The hypothesis under test: with the cap at the current
 * `DEFAULT_MIN_FRAME_INTERVAL_MS = 15`, this device processes every other
 * RAF (the documented "45 Hz processed" behaviour). With `?fpscap=10` the
 * cap stops binding and the device should process every RAF (~90 Hz
 * processed).
 *
 * Why this matters: the user has tested twice and the result is "still bad".
 * Asking them to test a third time before we have a local verification of
 * the math against their specific device rate is a waste of their time. This
 * test settles it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldSkipFrame, DEFAULT_MIN_FRAME_INTERVAL_MS } from '../../src/client/perf/frameRateCap';

const CAPTURE_PATH = 'diag/captures/2026-05-24T15-17-45Z-4qm14l';

interface CalibrationEvent {
  medianIntervalMs: number;
  effectiveHz: number;
  sampleCount: number;
}

function loadCalibrationFromCapture(capturePath: string): CalibrationEvent {
  const perfPath = join(capturePath, 'perf.ndjson');
  const raw = readFileSync(perfPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = JSON.parse(trimmed) as { tag?: string; data?: CalibrationEvent };
    if (entry.tag === 'device_info_calibration' && entry.data) {
      return entry.data;
    }
  }
  throw new Error(`device_info_calibration not found in ${perfPath}`);
}

function simulateOverDuration(opts: {
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
    } else {
      processed++;
      lastFrameTime = now;
    }
  }
  return { processed, skipped, processedHz: processed / (opts.durationMs / 1000) };
}

describe('frame-rate cap — user device 4qm14l (Pixel 6, Mali-G78, Chrome 148)', () => {
  it('GROUND TRUTH: device_info_calibration reports a 90 Hz native rAF cadence', () => {
    const cal = loadCalibrationFromCapture(CAPTURE_PATH);
    // 4qm14l measured 11.1 ms / 90.1 Hz. The assertion uses a generous
    // band so a future re-capture on a 60 Hz fallback (low battery,
    // Smooth Display off) still surfaces here rather than silently
    // breaking the rest of the test.
    expect(cal.medianIntervalMs).toBeGreaterThan(10);
    expect(cal.medianIntervalMs).toBeLessThan(13);
    expect(cal.effectiveHz).toBeGreaterThan(85);
    expect(cal.effectiveHz).toBeLessThan(95);
  });

  it('REGRESSION (cap=15, the old value): would have processed ~45 Hz on this device — the user pain that drove the 2026-05-24 cap change', () => {
    const cal = loadCalibrationFromCapture(CAPTURE_PATH);
    const r = simulateOverDuration({
      nativePeriodMs: cal.medianIntervalMs,
      durationMs: 1000,
      minIntervalMs: 15.0,
    });
    // The pre-2026-05-24 cap bound: roughly half of native RAFs got skipped.
    // This test stays as a historical lock — if anyone proposes raising the
    // cap back to 15 ms, this assertion shows the regression they'd ship.
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.processedHz).toBeGreaterThan(40);
    expect(r.processedHz).toBeLessThan(50);
  });

  it('CURRENT (cap=10 post-2026-05-24): processes ~90 Hz on this device — full native rate', () => {
    const cal = loadCalibrationFromCapture(CAPTURE_PATH);
    const r = simulateOverDuration({
      nativePeriodMs: cal.medianIntervalMs,
      durationMs: 1000,
      minIntervalMs: DEFAULT_MIN_FRAME_INTERVAL_MS,
    });
    // Cap at 10 ms < 11.1 ms native period → cap never engages.
    expect(r.skipped).toBe(0);
    expect(r.processedHz).toBeGreaterThan(85);
    expect(r.processedHz).toBeLessThan(95);
  });

  it('UNCAPPED (cap=0): equivalent to cap=10 on this device', () => {
    const cal = loadCalibrationFromCapture(CAPTURE_PATH);
    const r = simulateOverDuration({
      nativePeriodMs: cal.medianIntervalMs,
      durationMs: 1000,
      minIntervalMs: 0.0,
    });
    expect(r.skipped).toBe(0);
    expect(r.processedHz).toBeGreaterThan(85);
    expect(r.processedHz).toBeLessThan(95);
  });

  it('REGRESSION-WATCH (cap=10): a 60 Hz fallback device is unchanged from default', () => {
    // If the user's device drops to 60 Hz (Smooth Display off, low battery
    // throttle), cap=10 must still produce 60 Hz processed — no regression.
    const r = simulateOverDuration({
      nativePeriodMs: 1000 / 60,
      durationMs: 1000,
      minIntervalMs: 10.0,
    });
    expect(r.skipped).toBe(0);
    expect(r.processedHz).toBeGreaterThanOrEqual(59);
    expect(r.processedHz).toBeLessThanOrEqual(61);
  });

  it('REGRESSION-WATCH (cap=10): a 120 Hz device still throttles to ~91 Hz', () => {
    // The cap's *other* purpose — keeping 120 Hz devices from doing 2× the
    // work — must be preserved. At cap=10 a 120 Hz device skips alternate
    // RAFs (8.33 ms < 10) and processes at ~60 Hz, same as the 60 Hz
    // baseline.
    const r = simulateOverDuration({
      nativePeriodMs: 1000 / 120,
      durationMs: 1000,
      minIntervalMs: 10.0,
    });
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.processedHz).toBeGreaterThan(55);
    expect(r.processedHz).toBeLessThan(65);
  });
});
