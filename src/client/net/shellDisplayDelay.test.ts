import { describe, it, expect, afterEach } from 'vitest';
import { shellDisplayDelayGameMs, SHELL_DISPLAY_DELAY_MS } from './shellDisplayDelay.js';
import {
  getSwarmDisplayDelayMs,
  getSwarmHoldFrameCount,
  getSwarmSteadyDisplayDelayMs,
  noteSwarmStreamStamp,
  resetSwarmTickClock,
  setSwarmDisplayDelayMs,
  setSwarmDisplaySpeed,
  stepSwarmDisplayDelay,
  swarmArrivalStampMs,
} from './swarmInterpolation.js';
import { DISPLAY_DELAY_MS } from './swarmDelaySizing.js';

/** A drone delay between the floor and ceiling, in GAME ms (wall = this / speed). */
const RAISED_GAME_MS = 190;
/** A shared delay value for the pure checks (wall ms). */
const RAISED_WALL_MS = 180;
const FRAME_MS = 1000 / 60;
const TICK_GAME_MS = 1000 / 60;
const START_MS = 10_000;
const LINK_MS = 40;
/** Steady play before the stall, then a whole-stream stall (GAME ms: long
 *  enough to hold, short of the re-sync bound, at every speed). */
const LIVE_MS = 1000;
const STALL_GAME_MS = 550;

describe('shellDisplayDelayGameMs (S5-6a)', () => {
  afterEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
  });

  it('falls back to the fixed delay (game ms) for NaN, absent, zero or non-finite input', () => {
    expect(SHELL_DISPLAY_DELAY_MS).toBe(DISPLAY_DELAY_MS);
    for (const scale of [1, 2, 0.7]) {
      expect(shellDisplayDelayGameMs(Number.NaN, scale)).toBe(SHELL_DISPLAY_DELAY_MS);
      expect(shellDisplayDelayGameMs(undefined, scale)).toBe(SHELL_DISPLAY_DELAY_MS);
      expect(shellDisplayDelayGameMs(0, scale)).toBe(SHELL_DISPLAY_DELAY_MS);
      expect(shellDisplayDelayGameMs(Number.POSITIVE_INFINITY, scale)).toBe(SHELL_DISPLAY_DELAY_MS);
    }
  });

  it('uses the given delay when present: wall ms times the time scale', () => {
    expect(shellDisplayDelayGameMs(RAISED_WALL_MS, 1)).toBe(RAISED_WALL_MS);
    expect(shellDisplayDelayGameMs(RAISED_WALL_MS, 2)).toBe(RAISED_WALL_MS * 2);
    expect(shellDisplayDelayGameMs(RAISED_WALL_MS, 0.7)).toBeCloseTo(RAISED_WALL_MS * 0.7, 9);
  });

  // The drone delay floor is DISPLAY_DELAY_MS / speed (wall ms), so a clean
  // link draws shells exactly as before at any speed: 100 game ms.
  it.each([1, 2, 0.7])('the steady drone floor at %s× is the old 100 game ms', (speed) => {
    setSwarmDisplaySpeed(speed);
    setSwarmDisplayDelayMs(0); // clamps up to the floor
    expect(shellDisplayDelayGameMs(getSwarmSteadyDisplayDelayMs(), speed)).toBeCloseTo(SHELL_DISPLAY_DELAY_MS, 9);
  });

  it('the steady delay slews with the held one when nothing stalls', () => {
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
    setSwarmDisplayDelayMs(RAISED_GAME_MS);
    for (let f = 0; f < 30; f++) {
      stepSwarmDisplayDelay(FRAME_MS);
      expect(getSwarmSteadyDisplayDelayMs()).toBe(getSwarmDisplayDelayMs());
    }
    expect(getSwarmSteadyDisplayDelayMs()).toBeGreaterThan(DISPLAY_DELAY_MS);
  });

  // A whole drone stream stall: the hold grows the drones' delay; the steady
  // one (shells) stays at its target, so shells keep flying.
  it.each([1, 2, 0.7])('during a drone stall at %s× the held delay grows and the steady one does not', (speed) => {
    setSwarmDisplaySpeed(speed);
    const targetWallMs = RAISED_GAME_MS / speed;
    setSwarmDisplayDelayMs(targetWallMs);
    const tickWallMs = TICK_GAME_MS / speed;
    const holdsBefore = getSwarmHoldFrameCount();
    let tick = 0;
    let maxHeld = 0;
    for (let f = 1; f * FRAME_MS <= LIVE_MS + STALL_GAME_MS / speed; f++) {
      const rel = f * FRAME_MS;
      const now = START_MS + rel;
      while (tick * tickWallMs < LIVE_MS && tick * tickWallMs + LINK_MS <= rel) {
        noteSwarmStreamStamp(tick, swarmArrivalStampMs(tick, now));
        tick++;
      }
      stepSwarmDisplayDelay(FRAME_MS, now);
      if (rel < LIVE_MS) expect(getSwarmDisplayDelayMs()).toBeCloseTo(getSwarmSteadyDisplayDelayMs(), 9);
      maxHeld = Math.max(maxHeld, getSwarmDisplayDelayMs());
      expect(getSwarmSteadyDisplayDelayMs()).toBeCloseTo(targetWallMs, 9);
    }
    expect(getSwarmHoldFrameCount()).toBeGreaterThan(holdsBefore);
    expect(maxHeld).toBeGreaterThan(targetWallMs + 10);
    expect(shellDisplayDelayGameMs(getSwarmSteadyDisplayDelayMs(), speed)).toBeCloseTo(RAISED_GAME_MS, 9);
  });
});
