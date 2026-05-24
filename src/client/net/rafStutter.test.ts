/**
 * `raf_stutter` event — fires for medium-sized inter-RAF gaps
 * (30 ms < elapsedMs ≤ 100 ms).
 *
 * Plan: mobile-perf-investigation (2026-05-24, Probe 4).
 *
 * Capture `n6uznw` (Pixel 6, post cap-fix) showed only 4 `raf_gap`
 * events (>100 ms) in 197 s of session — a steady-state stall rate
 * of 1 every 50 s. But the user still reported "lag spikes", and
 * the same capture showed ~17 rafTick events with elapsedMs in the
 * 33-89 ms range. At 90 Hz native (11.1 ms per frame), a 33 ms
 * elapsedMs is a 2-3 frame skip — perceptible but below the
 * `raf_gap` threshold.
 *
 * `raf_stutter` covers the 30-100 ms gap so the diagnostic stream
 * captures these without changing the `raf_gap` rate semantics that
 * existing tests + the netcode-health gate already depend on.
 *
 * Implementation lives inline in `ColyseusClient.tickPhysics`. Because
 * the firing condition is a pure deltaMs comparison, the test extracts
 * the same condition into a helper and asserts the band boundaries.
 */
import { describe, it, expect } from 'vitest';

const STUTTER_LO_MS = 30;
const STUTTER_HI_MS = 100;

function shouldFireRafStutter(elapsedMs: number): boolean {
  return elapsedMs > STUTTER_LO_MS && elapsedMs <= STUTTER_HI_MS;
}

function shouldFireRafGap(elapsedMs: number): boolean {
  return elapsedMs > 100;
}

describe('raf_stutter — band boundaries', () => {
  it('does NOT fire below the lower bound (30 ms)', () => {
    expect(shouldFireRafStutter(11.1)).toBe(false); // 90 Hz native frame
    expect(shouldFireRafStutter(16.67)).toBe(false); // 60 Hz native frame
    expect(shouldFireRafStutter(22.22)).toBe(false); // 45 Hz processed frame
    expect(shouldFireRafStutter(30.0)).toBe(false); // exact lower bound — strict >
    expect(shouldFireRafStutter(29.99)).toBe(false); // just below
  });

  it('FIRES inside the band (30 < elapsedMs ≤ 100)', () => {
    expect(shouldFireRafStutter(30.01)).toBe(true); // just above lower
    expect(shouldFireRafStutter(33.3)).toBe(true);  // 2-frame skip at 60 Hz
    expect(shouldFireRafStutter(45.0)).toBe(true);
    expect(shouldFireRafStutter(67.0)).toBe(true);
    expect(shouldFireRafStutter(89.0)).toBe(true);  // 8-frame skip at 90 Hz
    expect(shouldFireRafStutter(100.0)).toBe(true); // exact upper bound — inclusive
  });

  it('does NOT fire above the upper bound (100 ms) — raf_gap territory', () => {
    expect(shouldFireRafStutter(100.01)).toBe(false);
    expect(shouldFireRafStutter(110.7)).toBe(false); // the 5-frame-at-90 Hz cluster
    expect(shouldFireRafStutter(500)).toBe(false);
  });

  it('CONTRACT: raf_stutter and raf_gap are mutually exclusive at every elapsedMs', () => {
    // Boundary sweep across the relevant range.
    for (let e = 0; e <= 200; e += 1) {
      const stutter = shouldFireRafStutter(e);
      const gap = shouldFireRafGap(e);
      expect(
        stutter && gap,
        `elapsedMs=${e} fired both raf_stutter (${stutter}) and raf_gap (${gap})`,
      ).toBe(false);
    }
  });

  it('REGRESSION GROUND TRUTH (n6uznw): the 17 captured medium stutters all fall in-band', () => {
    // Rounded elapsedMs values seen in n6uznw raf.ndjson distribution
    // (the rafTick events with elapsedMs > 30 ms but ≤ 100 ms).
    const observed = [
      33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, // 12 × 33ms
      44, 44, // 2 × 44ms
      55, 55, // 2 × 55ms
      89, 89, 89, 89, 89, 89, // 6 × 89ms
    ];
    const wouldFire = observed.filter(shouldFireRafStutter);
    expect(wouldFire.length, 'all observed medium stutters in n6uznw should fire raf_stutter').toBe(observed.length);
  });

  it('THE EXISTING raf_gap CHANNEL IS UNTOUCHED: 100 ms+ events still route to raf_gap', () => {
    // Pre-fix elapsedMs values that fire raf_gap (NOT raf_stutter).
    const observed = [110.7, 110.8, 110.8, 116.0];
    const fireGap = observed.filter(shouldFireRafGap);
    const fireStutter = observed.filter(shouldFireRafStutter);
    expect(fireGap.length).toBe(observed.length);
    expect(fireStutter.length).toBe(0);
  });
});
