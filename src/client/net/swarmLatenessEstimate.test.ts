/**
 * Drone lateness estimate (netcode gap smoothing, S3-1).
 *
 * The estimator on synthetic lateness series (wall ms, one sample per packet):
 * a step up is tracked fast, a step down decays slowly, a noisy series gives a
 * deviation near its spread. Then the wiring: `swarmArrivalStampMs` feeds it
 * and `resetSwarmTickClock` clears it.
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
  type LatenessEstimate,
} from './swarmInterpolation.js';

const TICK_MS = 1000 / 60;
const STEP_MS = 40;
/** Packets within which a step up must reach 90 % (rise tau 50 ms ≈ 3 packets). */
const RISE_PACKETS_90 = 7;
/** One second of packets at 60 Hz. */
const ONE_SECOND_PACKETS = 60;

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
