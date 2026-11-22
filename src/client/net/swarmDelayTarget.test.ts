/**
 * Drone display-delay target (netcode gap smoothing, S5-7, owner decision
 * "cap delay + fix hold"). The target follows the binary swarm inter-arrival
 * EWMA (`nextSwarmInterArrivalEwmaMs`, the estimator `ColyseusClient` runs per
 * swarm packet) × ADAPTIVE_DELAY_FACTOR + the JSON drop bias, fed once per
 * snapshot through `feedSwarmDisplayDelayTarget`, and is clamped to the
 * 100 ms floor and the 150 ms ceiling (game ms, ÷ speed). Packet lateness no
 * longer sizes it: on 4G that pinned the target at the old 280 ms ceiling.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ADAPTIVE_DELAY_CEILING_MS,
  ADAPTIVE_DELAY_FACTOR,
  DISPLAY_DELAY_MS,
  SWARM_INTER_ARRIVAL_KEEP,
  SWARM_INTER_ARRIVAL_SAMPLE_CAP_MS,
  feedSwarmDisplayDelayTarget,
  getSwarmDisplayDelayMs,
  getSwarmDisplayDelayTargetMs,
  nextSwarmInterArrivalEwmaMs,
  resetSwarmTickClock,
  setSwarmDisplayDelayMs,
  setSwarmDisplaySpeed,
  swarmArrivalStampMs,
} from './swarmInterpolation.js';

const TICK_MS = 1000 / 60;
const FLOAT_DIGITS = 9;
/** Game speeds the clamp must scale at (sector time scale). */
const SLOW_SPEED = 0.7;
const FAST_SPEED = 2;
/** A target between the floor and the ceiling (wall ms at 1×). */
const MID_TARGET_MS = 120;
/** Packets fed to the wiring tests, and how late the odd ones arrive. */
const FEED_PACKETS = 60;
const LATE_MS = 200;

beforeEach(() => {
  resetSwarmTickClock();
  setSwarmDisplaySpeed(1);
});

describe('swarm inter-arrival EWMA (S5-7)', () => {
  it('the first sample seeds it; later ones blend in at 1 − keep', () => {
    expect(nextSwarmInterArrivalEwmaMs(0, 40)).toBe(40);
    const next = nextSwarmInterArrivalEwmaMs(40, 20);
    expect(next).toBeCloseTo(40 * SWARM_INTER_ARRIVAL_KEEP + 20 * (1 - SWARM_INTER_ARRIVAL_KEEP), FLOAT_DIGITS);
  });

  it('caps one long gap at the sample cap', () => {
    expect(nextSwarmInterArrivalEwmaMs(0, 5000)).toBe(SWARM_INTER_ARRIVAL_SAMPLE_CAP_MS);
    const capped = nextSwarmInterArrivalEwmaMs(TICK_MS, 5000);
    expect(capped).toBeCloseTo(
      TICK_MS * SWARM_INTER_ARRIVAL_KEEP + SWARM_INTER_ARRIVAL_SAMPLE_CAP_MS * (1 - SWARM_INTER_ARRIVAL_KEEP), FLOAT_DIGITS);
  });

  it('a zero, negative or NaN gap (two packets in one frame) leaves it alone', () => {
    expect(nextSwarmInterArrivalEwmaMs(30, 0)).toBe(30);
    expect(nextSwarmInterArrivalEwmaMs(30, -5)).toBe(30);
    expect(nextSwarmInterArrivalEwmaMs(30, Number.NaN)).toBe(30);
  });

  it('a per-tick stream sits under the floor once × the factor', () => {
    let ewma = 0;
    for (let i = 0; i < FEED_PACKETS; i++) ewma = nextSwarmInterArrivalEwmaMs(ewma, TICK_MS);
    expect(ewma * ADAPTIVE_DELAY_FACTOR).toBeLessThan(DISPLAY_DELAY_MS);
  });
});

describe('display-delay target feed (S5-7)', () => {
  it('the ceiling is 150 game ms', () => {
    expect(ADAPTIVE_DELAY_CEILING_MS).toBe(150);
    expect(ADAPTIVE_DELAY_FACTOR).toBe(1.5);
  });

  it('clamps to the floor and the ceiling; between them it is the input', () => {
    feedSwarmDisplayDelayTarget(10);
    expect(getSwarmDisplayDelayTargetMs()).toBe(DISPLAY_DELAY_MS);
    feedSwarmDisplayDelayTarget(MID_TARGET_MS);
    expect(getSwarmDisplayDelayTargetMs()).toBe(MID_TARGET_MS);
    feedSwarmDisplayDelayTarget(SWARM_INTER_ARRIVAL_SAMPLE_CAP_MS * ADAPTIVE_DELAY_FACTOR);
    expect(getSwarmDisplayDelayTargetMs()).toBe(ADAPTIVE_DELAY_CEILING_MS);
  });

  it('floor and ceiling are game ms: divided by the speed at 0.7x and 2x', () => {
    for (const speed of [SLOW_SPEED, FAST_SPEED]) {
      resetSwarmTickClock();
      setSwarmDisplaySpeed(speed);
      feedSwarmDisplayDelayTarget(0);
      expect(getSwarmDisplayDelayTargetMs()).toBeCloseTo(DISPLAY_DELAY_MS / speed, FLOAT_DIGITS);
      feedSwarmDisplayDelayTarget(10_000);
      expect(getSwarmDisplayDelayTargetMs()).toBeCloseTo(ADAPTIVE_DELAY_CEILING_MS / speed, FLOAT_DIGITS);
    }
  });

  it('the first feed places the value at the target; later feeds only move the target', () => {
    feedSwarmDisplayDelayTarget(MID_TARGET_MS);
    expect(getSwarmDisplayDelayMs()).toBe(MID_TARGET_MS);
    feedSwarmDisplayDelayTarget(ADAPTIVE_DELAY_CEILING_MS);
    expect(getSwarmDisplayDelayTargetMs()).toBe(ADAPTIVE_DELAY_CEILING_MS);
    expect(getSwarmDisplayDelayMs()).toBe(MID_TARGET_MS);
  });

  it('a speed change re-clamps the fed target into the new range', () => {
    feedSwarmDisplayDelayTarget(ADAPTIVE_DELAY_CEILING_MS);
    setSwarmDisplaySpeed(FAST_SPEED);
    expect(getSwarmDisplayDelayTargetMs()).toBe(ADAPTIVE_DELAY_CEILING_MS / FAST_SPEED);
  });

  it('late drone packets do not move the target (lateness no longer sizes it)', () => {
    for (let tick = 0; tick < FEED_PACKETS; tick++) {
      swarmArrivalStampMs(tick, 10_000 + tick * TICK_MS + (tick % 2 === 1 ? LATE_MS : 0));
    }
    expect(getSwarmDisplayDelayTargetMs()).toBe(DISPLAY_DELAY_MS);
    expect(getSwarmDisplayDelayMs()).toBe(DISPLAY_DELAY_MS);
  });

  it('setSwarmDisplayDelayMs pins the target against the feed until the next reset', () => {
    setSwarmDisplayDelayMs(ADAPTIVE_DELAY_CEILING_MS);
    feedSwarmDisplayDelayTarget(0);
    expect(getSwarmDisplayDelayTargetMs()).toBe(ADAPTIVE_DELAY_CEILING_MS);
    resetSwarmTickClock();
    feedSwarmDisplayDelayTarget(MID_TARGET_MS);
    expect(getSwarmDisplayDelayTargetMs()).toBe(MID_TARGET_MS);
  });
});
