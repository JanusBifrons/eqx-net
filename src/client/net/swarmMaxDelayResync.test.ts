/**
 * S4-4 (netcode gap smoothing, wave 5): the maximum total drone display delay
 * (`MAX_TOTAL_DISPLAY_DELAY_MS`, 400 game ms, wall = 400 / speed) and the
 * counted re-sync. Nothing in production calls these yet; S4-5 lets the delay
 * grow during a stream stall and bounds it here.
 *
 * A held delay at or under the bound is returned unchanged; past it the delay
 * resets to its target in one step, and the caller counts exactly one re-sync
 * (`noteSwarmResync`, read with `getSwarmResyncCount`, zeroed by
 * `resetSwarmTickClock` with the other drone stream counters).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_TOTAL_DISPLAY_DELAY_MS,
  ADAPTIVE_DELAY_CEILING_MS,
  EXTRAPOLATION_LIMIT_MS,
  swarmHoldBoundWallMs,
  boundSwarmHoldDelayMs,
  isSwarmHoldDelayOverMax,
  noteSwarmResync,
  getSwarmResyncCount,
  resetSwarmTickClock,
} from './swarmInterpolation.js';

/** A steady display-delay target (wall ms at 1x). */
const TARGET_WALL_MS = 180;
/** How far (wall ms) past or short of the bound the edge cases sit. */
const EDGE_MS = 1;
const SLOW_SPEED = 0.7;
const FAST_SPEED = 2;

/** The S4-5 call pattern: bound the request and count a re-sync once. */
function holdDelay(requestedWallMs: number, targetWallMs: number, speed: number): number {
  if (isSwarmHoldDelayOverMax(requestedWallMs, speed)) noteSwarmResync();
  return boundSwarmHoldDelayMs(requestedWallMs, targetWallMs, speed);
}

describe('MAX_TOTAL_DISPLAY_DELAY_MS', () => {
  it('is 400 game ms, above the 280 ms steady ceiling (owner decision D2)', () => {
    expect(MAX_TOTAL_DISPLAY_DELAY_MS).toBe(400);
    expect(MAX_TOTAL_DISPLAY_DELAY_MS).toBeGreaterThan(ADAPTIVE_DELAY_CEILING_MS);
  });
});

describe('boundSwarmHoldDelayMs + counted re-sync', () => {
  beforeEach(() => {
    resetSwarmTickClock();
  });

  it('under the bound: returns the request unchanged and counts no re-sync', () => {
    const requested = 320;
    expect(isSwarmHoldDelayOverMax(requested, 1)).toBe(false);
    expect(holdDelay(requested, TARGET_WALL_MS, 1)).toBe(requested);
    expect(getSwarmResyncCount()).toBe(0);
  });

  it('over the bound: returns the target and counts exactly one re-sync', () => {
    const requested = MAX_TOTAL_DISPLAY_DELAY_MS + EDGE_MS;
    expect(isSwarmHoldDelayOverMax(requested, 1)).toBe(true);
    expect(holdDelay(requested, TARGET_WALL_MS, 1)).toBe(TARGET_WALL_MS);
    expect(getSwarmResyncCount()).toBe(1);
  });

  it('exactly at the bound: returns the request, no re-sync', () => {
    expect(holdDelay(MAX_TOTAL_DISPLAY_DELAY_MS, TARGET_WALL_MS, 1)).toBe(MAX_TOTAL_DISPLAY_DELAY_MS);
    expect(getSwarmResyncCount()).toBe(0);
  });

  it('a non-finite request re-syncs to the target', () => {
    expect(holdDelay(Number.NaN, TARGET_WALL_MS, 1)).toBe(TARGET_WALL_MS);
    expect(holdDelay(Number.POSITIVE_INFINITY, TARGET_WALL_MS, 1)).toBe(TARGET_WALL_MS);
    expect(getSwarmResyncCount()).toBe(2);
  });

  it('scales with speed at 0.7x: the bound is 400 / 0.7 wall ms', () => {
    const boundWall = MAX_TOTAL_DISPLAY_DELAY_MS / SLOW_SPEED;
    const target = TARGET_WALL_MS / SLOW_SPEED;
    // 500 wall ms is over the 1x bound but under the 0.7x one (~571 ms).
    expect(holdDelay(500, target, SLOW_SPEED)).toBe(500);
    expect(holdDelay(boundWall, target, SLOW_SPEED)).toBe(boundWall);
    expect(getSwarmResyncCount()).toBe(0);
    expect(holdDelay(boundWall + EDGE_MS, target, SLOW_SPEED)).toBe(target);
    expect(getSwarmResyncCount()).toBe(1);
  });

  // Above 1x a network stall (wall time) of the 1x length must still hold:
  // bound + glide stays 650 wall ms, so the bound is (400 + 250) − 250 / speed.
  it('above 1x keeps the 1x stall length: at 2x the bound is (400 + 250) − 250 / 2 = 525 wall ms', () => {
    const boundWall = swarmHoldBoundWallMs(FAST_SPEED);
    expect(boundWall).toBe(MAX_TOTAL_DISPLAY_DELAY_MS + EXTRAPOLATION_LIMIT_MS - EXTRAPOLATION_LIMIT_MS / FAST_SPEED);
    expect(boundWall + EXTRAPOLATION_LIMIT_MS / FAST_SPEED).toBe(MAX_TOTAL_DISPLAY_DELAY_MS + EXTRAPOLATION_LIMIT_MS);
    const target = TARGET_WALL_MS / FAST_SPEED;
    // 300 wall ms: over the old 400 / 2 bound, under this one.
    expect(holdDelay(300, target, FAST_SPEED)).toBe(300);
    expect(holdDelay(boundWall - EDGE_MS, target, FAST_SPEED)).toBe(boundWall - EDGE_MS);
    expect(holdDelay(boundWall, target, FAST_SPEED)).toBe(boundWall);
    expect(getSwarmResyncCount()).toBe(0);
    expect(holdDelay(boundWall + EDGE_MS, target, FAST_SPEED)).toBe(target);
    expect(getSwarmResyncCount()).toBe(1);
  });

  it('at or below 1x the bound is exactly 400 / speed', () => {
    for (const speed of [0.5, SLOW_SPEED, 1]) expect(swarmHoldBoundWallMs(speed)).toBe(MAX_TOTAL_DISPLAY_DELAY_MS / speed);
    // A garbage speed counts as 1.
    expect(swarmHoldBoundWallMs(Number.NaN)).toBe(MAX_TOTAL_DISPLAY_DELAY_MS);
  });

  it('the re-sync counter resets with the other drone stream counters', () => {
    noteSwarmResync();
    noteSwarmResync();
    expect(getSwarmResyncCount()).toBe(2);
    resetSwarmTickClock();
    expect(getSwarmResyncCount()).toBe(0);
  });
});
