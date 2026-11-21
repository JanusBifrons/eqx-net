/**
 * Slewed drone display delay (netcode gap smoothing, S3-2).
 *
 * `setSwarmDisplayDelayMs` sets a TARGET; `stepSwarmDisplayDelay(frameMs)`
 * (once per frame, `updateSwarmMirror`) moves the value toward it,
 * proportional to the gap but never more than
 * `DISPLAY_DELAY_SLEW_MAX_RATE × frameMs` per frame either way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resetSwarmTickClock,
  resetSwarmDisplayDelay,
  setSwarmDisplaySpeed,
  setSwarmDisplayDelayMs,
  stepSwarmDisplayDelay,
  getSwarmDisplayDelayMs,
  getSwarmDisplayDelayTargetMs,
  swarmArrivalStampMs,
  getSwarmLatenessEstimateMs,
  DISPLAY_DELAY_MS,
  ADAPTIVE_DELAY_CEILING_MS,
  DISPLAY_DELAY_SLEW_MAX_RATE,
} from './swarmInterpolation.js';

const FRAME_60HZ_MS = 1000 / 60;
/** An uneven frame series (wall ms): fast, slow, a hitch, tiny frames. */
const UNEVEN_FRAMES_MS = [8, 33, 16.7, 50, 4, 100, 12, 0.5, 25, 16.7];
/** Target jumps, up and down, inside and beyond the clamp. */
const TARGET_JUMPS_MS = [250, 120, 1000, 0, 180, 140, 280, 100];
/** Frames each target is held: long enough to converge (~20 s at 60 Hz). */
const FRAMES_PER_TARGET = 1200;
/** Float slack on the per-frame bound. */
const EPS = 1e-9;

/** Step `frames` frames from `series` (cycled) and check the bound on each. */
function stepChecked(series: readonly number[], frames: number, startIndex = 0): number {
  let maxRatio = 0;
  for (let i = 0; i < frames; i++) {
    const dt = series[(startIndex + i) % series.length]!;
    const before = getSwarmDisplayDelayMs();
    stepSwarmDisplayDelay(dt);
    const change = Math.abs(getSwarmDisplayDelayMs() - before);
    expect(change).toBeLessThanOrEqual(DISPLAY_DELAY_SLEW_MAX_RATE * dt + EPS);
    maxRatio = Math.max(maxRatio, change / dt);
  }
  return maxRatio;
}

describe('slewed drone display delay', () => {
  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
  });
  afterEach(() => resetSwarmTickClock());

  it('the first set after a reset starts AT the target (no glide from the floor)', () => {
    expect(getSwarmDisplayDelayMs()).toBe(DISPLAY_DELAY_MS);
    setSwarmDisplayDelayMs(200);
    expect(getSwarmDisplayDelayMs()).toBe(200);
    expect(getSwarmDisplayDelayTargetMs()).toBe(200);
    // The second set only moves the target.
    setSwarmDisplayDelayMs(250);
    expect(getSwarmDisplayDelayMs()).toBe(200);
    expect(getSwarmDisplayDelayTargetMs()).toBe(250);
  });

  it('a good link: target at the floor, value equal to it on every frame', () => {
    for (let i = 0; i < 600; i++) {
      setSwarmDisplayDelayMs(16.7 * 1.5); // clean inter-arrival: clamps to the floor
      stepSwarmDisplayDelay(FRAME_60HZ_MS);
      expect(getSwarmDisplayDelayMs()).toBe(DISPLAY_DELAY_MS);
    }
  });

  it('60 Hz: per-frame change within the bound across jumps up and down; converges', () => {
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
    let sawBound = 0;
    for (const target of TARGET_JUMPS_MS) {
      setSwarmDisplayDelayMs(target);
      sawBound = Math.max(sawBound, stepChecked([FRAME_60HZ_MS], FRAMES_PER_TARGET));
      expect(getSwarmDisplayDelayMs()).toBe(getSwarmDisplayDelayTargetMs());
    }
    // A big jump does hit the bound (the bound is what limits it, not the gain).
    expect(sawBound).toBeCloseTo(DISPLAY_DELAY_SLEW_MAX_RATE, 6);
  });

  it('a 100 → 280 ms step takes at least 1.8 s at the bound', () => {
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
    setSwarmDisplayDelayMs(ADAPTIVE_DELAY_CEILING_MS);
    const minFrames = Math.floor((ADAPTIVE_DELAY_CEILING_MS - DISPLAY_DELAY_MS) / (DISPLAY_DELAY_SLEW_MAX_RATE * FRAME_60HZ_MS));
    for (let i = 0; i < minFrames - 1; i++) stepSwarmDisplayDelay(FRAME_60HZ_MS);
    expect(getSwarmDisplayDelayMs()).toBeLessThan(ADAPTIVE_DELAY_CEILING_MS);
  });

  it('uneven frames: per-frame change within the bound of each frame; converges', () => {
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
    let frame = 0;
    for (const target of TARGET_JUMPS_MS) {
      setSwarmDisplayDelayMs(target);
      stepChecked(UNEVEN_FRAMES_MS, FRAMES_PER_TARGET, frame);
      frame += FRAMES_PER_TARGET;
      expect(getSwarmDisplayDelayMs()).toBe(getSwarmDisplayDelayTargetMs());
    }
  });

  it('a zero, negative or non-finite frame does not move the value', () => {
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
    setSwarmDisplayDelayMs(ADAPTIVE_DELAY_CEILING_MS);
    for (const dt of [0, -16, Number.NaN, Number.POSITIVE_INFINITY]) {
      stepSwarmDisplayDelay(dt);
      expect(getSwarmDisplayDelayMs()).toBe(DISPLAY_DELAY_MS);
    }
  });

  it('resetSwarmTickClock puts the value back at the floor and re-arms the first-set snap', () => {
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
    setSwarmDisplayDelayMs(ADAPTIVE_DELAY_CEILING_MS);
    stepSwarmDisplayDelay(FRAME_60HZ_MS * 30);
    expect(getSwarmDisplayDelayMs()).toBeGreaterThan(DISPLAY_DELAY_MS);
    resetSwarmTickClock();
    expect(getSwarmDisplayDelayMs()).toBe(DISPLAY_DELAY_MS);
    expect(getSwarmDisplayDelayTargetMs()).toBe(DISPLAY_DELAY_MS);
    setSwarmDisplayDelayMs(220);
    expect(getSwarmDisplayDelayMs()).toBe(220);
  });

  it('resetSwarmDisplayDelay resets the delay and clears the lateness estimate', () => {
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
    setSwarmDisplayDelayMs(ADAPTIVE_DELAY_CEILING_MS);
    stepSwarmDisplayDelay(FRAME_60HZ_MS * 30);
    swarmArrivalStampMs(0, 10_000);
    for (let tick = 1; tick <= 10; tick++) swarmArrivalStampMs(tick, 10_000 + tick * FRAME_60HZ_MS + 40);
    expect(getSwarmLatenessEstimateMs()).toBeGreaterThan(0);
    resetSwarmDisplayDelay();
    expect(getSwarmDisplayDelayMs()).toBe(DISPLAY_DELAY_MS);
    expect(getSwarmDisplayDelayTargetMs()).toBe(DISPLAY_DELAY_MS);
    expect(getSwarmLatenessEstimateMs()).toBe(0);
    setSwarmDisplayDelayMs(150);
    expect(getSwarmDisplayDelayMs()).toBe(150);
  });
});
