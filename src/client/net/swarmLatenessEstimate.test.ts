/**
 * Drone lateness estimate (netcode gap smoothing, S3-1).
 *
 * The estimator on synthetic lateness series (wall ms, one sample per packet):
 * a step up is tracked fast, a step down decays slowly, a noisy series gives a
 * deviation near its spread. Then the wiring: `swarmArrivalStampMs` feeds it
 * and `resetSwarmTickClock` clears it. Last (S3-3): the display-delay target
 * formula and its per-packet feed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  updateLatenessEstimate,
  swarmArrivalStampMs,
  resetSwarmTickClock,
  setSwarmDisplaySpeed,
  getSwarmLatenessEstimateMs,
  getSwarmLatenessDeviationMs,
  getSwarmLatenessLastMs,
  getSwarmDisplayDelayMs,
  getSwarmDisplayDelayTargetMs,
  setSwarmDisplayDelayMs,
  swarmDisplayDelayTargetFromLatenessMs,
  DISPLAY_DELAY_MS,
  ADAPTIVE_DELAY_CEILING_MS,
  LATENESS_TARGET_DEVIATIONS,
  LATENESS_TARGET_FRAME_MS,
  type LatenessEstimate,
} from './swarmInterpolation.js';

const TICK_MS = 1000 / 60;
const STEP_MS = 40;
/** Packets within which a step up must reach 90 % (rise tau 50 ms ≈ 3 packets). */
const RISE_PACKETS_90 = 7;
/** One second of packets at 60 Hz. */
const ONE_SECOND_PACKETS = 60;
/** Game speeds the target must scale at (sector time scale). */
const SLOW_SPEED = 0.7;
const FAST_SPEED = 2;
/** Packets fed to the wiring tests. */
const FEED_PACKETS = 30;
/** Lateness added to every other packet in the wiring test (wall ms). */
const LATE_MS = 60;
const FLOAT_DIGITS = 9;

function fresh(): LatenessEstimate {
  return { estimateMs: 0, deviationMs: 0 };
}

function feed(est: LatenessEstimate, sampleMs: number, n: number): void {
  for (let i = 0; i < n; i++) updateLatenessEstimate(est, sampleMs);
}

describe('drone lateness estimate', () => {
  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
  });

  it('tracks a step up to 90 % within 7 packets', () => {
    const est = fresh();
    feed(est, STEP_MS, RISE_PACKETS_90 - 1);
    expect(est.estimateMs).toBeLessThan(0.9 * STEP_MS);
    updateLatenessEstimate(est, STEP_MS);
    expect(est.estimateMs).toBeGreaterThanOrEqual(0.9 * STEP_MS);
    expect(est.estimateMs).toBeLessThanOrEqual(STEP_MS);
  });

  it('decays a step down slowly (over half the step left after 1 s)', () => {
    const est = fresh();
    feed(est, STEP_MS, 200);
    expect(est.estimateMs).toBeCloseTo(STEP_MS, 3);
    feed(est, 0, ONE_SECOND_PACKETS);
    expect(est.estimateMs).toBeGreaterThan(0.5 * STEP_MS);
    expect(est.estimateMs).toBeLessThan(0.7 * STEP_MS);
    // ...and it does get there in the end (~10 s).
    feed(est, 0, 10 * ONE_SECOND_PACKETS);
    expect(est.estimateMs).toBeLessThan(0.01 * STEP_MS);
  });

  it('gives a deviation near the spread of a noisy series', () => {
    const est = fresh();
    // Alternating 10 / 30 ms (spread ±10 around 20): the estimate rides near
    // the top (rise fast, fall slow) and the deviation near the 20 ms swing / 2.
    for (let i = 0; i < 2000; i++) updateLatenessEstimate(est, i % 2 === 0 ? 30 : 10);
    expect(est.estimateMs).toBeGreaterThan(25);
    expect(est.estimateMs).toBeLessThanOrEqual(30);
    expect(est.deviationMs).toBeGreaterThan(8);
    expect(est.deviationMs).toBeLessThan(12);
  });

  it('a steady series has ~zero deviation', () => {
    const est = fresh();
    feed(est, 25, 600);
    expect(est.deviationMs).toBeLessThan(0.01);
  });

  it('is fed by the tick clock and cleared by resetSwarmTickClock', () => {
    const t0 = 10_000;
    // First packet seeds the clock (lateness 0); later ones arrive late.
    swarmArrivalStampMs(0, t0);
    for (let tick = 1; tick <= 30; tick++) swarmArrivalStampMs(tick, t0 + tick * TICK_MS + STEP_MS);
    expect(getSwarmLatenessLastMs()).toBeGreaterThan(0);
    expect(getSwarmLatenessEstimateMs()).toBeGreaterThan(0.5 * getSwarmLatenessLastMs());
    expect(getSwarmLatenessDeviationMs()).toBeGreaterThan(0);

    resetSwarmTickClock();
    expect(getSwarmLatenessEstimateMs()).toBe(0);
    expect(getSwarmLatenessDeviationMs()).toBe(0);
  });
});

describe('display-delay target from lateness (S3-3)', () => {
  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
  });

  it('a good link (a few ms late) gives the 100 ms floor', () => {
    expect(swarmDisplayDelayTargetFromLatenessMs(0, 0, 1)).toBe(DISPLAY_DELAY_MS);
    expect(swarmDisplayDelayTargetFromLatenessMs(5, 2, 1)).toBe(DISPLAY_DELAY_MS);
  });

  it('above the floor: estimate + 4 x deviation + one frame (wall ms)', () => {
    expect(LATENESS_TARGET_DEVIATIONS).toBe(4);
    expect(LATENESS_TARGET_FRAME_MS).toBeCloseTo(TICK_MS, FLOAT_DIGITS);
    expect(swarmDisplayDelayTargetFromLatenessMs(100, 20, 1)).toBeCloseTo(100 + 4 * 20 + TICK_MS, FLOAT_DIGITS);
    // Deviation counts four times: +10 ms deviation moves the target 40 ms.
    expect(swarmDisplayDelayTargetFromLatenessMs(100, 30, 1) - swarmDisplayDelayTargetFromLatenessMs(100, 20, 1))
      .toBeCloseTo(40, FLOAT_DIGITS);
  });

  it('clamps to the 280 ms ceiling', () => {
    expect(swarmDisplayDelayTargetFromLatenessMs(250, 20, 1)).toBe(ADAPTIVE_DELAY_CEILING_MS);
    expect(swarmDisplayDelayTargetFromLatenessMs(1e6, 1e6, 1)).toBe(ADAPTIVE_DELAY_CEILING_MS);
  });

  it('floor and ceiling are game ms: divided by the speed at 0.7x and 2x; the sum is not', () => {
    for (const speed of [SLOW_SPEED, FAST_SPEED]) {
      expect(swarmDisplayDelayTargetFromLatenessMs(0, 0, speed)).toBeCloseTo(DISPLAY_DELAY_MS / speed, FLOAT_DIGITS);
      expect(swarmDisplayDelayTargetFromLatenessMs(1e6, 0, speed)).toBeCloseTo(ADAPTIVE_DELAY_CEILING_MS / speed, FLOAT_DIGITS);
    }
    // Inside the range the wall-ms sum passes through unscaled.
    expect(swarmDisplayDelayTargetFromLatenessMs(150, 10, SLOW_SPEED)).toBeCloseTo(150 + 40 + TICK_MS, FLOAT_DIGITS);
    expect(swarmDisplayDelayTargetFromLatenessMs(80, 5, FAST_SPEED)).toBeCloseTo(80 + 20 + TICK_MS, FLOAT_DIGITS);
    // 0.7x: floor ~142.9, ceiling 400 wall ms; 2x: floor 50, ceiling 140.
    expect(swarmDisplayDelayTargetFromLatenessMs(10, 0, FAST_SPEED)).toBe(DISPLAY_DELAY_MS / FAST_SPEED);
    expect(swarmDisplayDelayTargetFromLatenessMs(200, 0, FAST_SPEED)).toBe(ADAPTIVE_DELAY_CEILING_MS / FAST_SPEED);
  });

  it('every packet sets the target from the estimate; the first places the value there', () => {
    for (let tick = 0; tick < FEED_PACKETS; tick++) {
      swarmArrivalStampMs(tick, 10_000 + tick * TICK_MS + (tick % 2 === 1 ? LATE_MS : 0));
      const expected = swarmDisplayDelayTargetFromLatenessMs(getSwarmLatenessEstimateMs(), getSwarmLatenessDeviationMs(), 1);
      expect(getSwarmDisplayDelayTargetMs()).toBeCloseTo(expected, FLOAT_DIGITS);
    }
    expect(getSwarmDisplayDelayTargetMs()).toBeGreaterThan(DISPLAY_DELAY_MS);
    // The value only slews (stepSwarmDisplayDelay); the first packet placed it at the floor.
    expect(getSwarmDisplayDelayMs()).toBe(DISPLAY_DELAY_MS);
  });

  it('a speed change re-clamps the fed target into the new range', () => {
    for (let tick = 0; tick < FEED_PACKETS; tick++) swarmArrivalStampMs(tick, 10_000 + tick * TICK_MS);
    expect(getSwarmDisplayDelayTargetMs()).toBe(DISPLAY_DELAY_MS);
    setSwarmDisplaySpeed(FAST_SPEED);
    expect(getSwarmDisplayDelayTargetMs()).toBe(DISPLAY_DELAY_MS / FAST_SPEED);
  });

  it('setSwarmDisplayDelayMs pins the target until the next reset', () => {
    setSwarmDisplayDelayMs(ADAPTIVE_DELAY_CEILING_MS);
    for (let tick = 0; tick < FEED_PACKETS; tick++) swarmArrivalStampMs(tick, 10_000 + tick * TICK_MS);
    expect(getSwarmDisplayDelayTargetMs()).toBe(ADAPTIVE_DELAY_CEILING_MS);
    resetSwarmTickClock();
    swarmArrivalStampMs(0, 20_000);
    expect(getSwarmDisplayDelayTargetMs()).toBe(DISPLAY_DELAY_MS);
  });
});
