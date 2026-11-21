/**
 * The drone teleport guard measures its span in GAME ms.
 *
 * Pose stamps are wall ms; `TELEPORT_MAX_PLAUSIBLE_SPEED` is a game speed. At
 * 2× a drone covers twice the game distance per wall ms, so the span is
 * scaled by the display speed before the check (game ms = wall ms × speed).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  interpolateSwarmPose, setSwarmDisplaySpeed, setSwarmDisplayDelayMs, getSwarmDisplayDelayMs,
  resetSwarmTickClock, TELEPORT_MAX_PLAUSIBLE_SPEED, type InterpolatedPose,
} from './swarmInterpolation.js';
import { POSE_RING_DEPTH, type PoseRingEntry, type SwarmRenderState } from '../../core/contracts/IRenderer.js';

const A_MS = 1000;
/** Wall ms between the two bracketing poses. */
const WALL_SPAN_MS = 50;
/** Just under the bound for `gameSpanMs`. */
function legitGap(gameSpanMs: number): number {
  return TELEPORT_MAX_PLAUSIBLE_SPEED * gameSpanMs / 1000 - 1;
}

function pose(x: number, arrivalMs: number, empty = false): PoseRingEntry {
  return { x, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs, serverTick: 0, sleeping: false, empty };
}

function entry(gap: number): SwarmRenderState {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push(pose(0, 0, true));
  ring[0] = pose(0, A_MS);
  ring[1] = pose(gap, A_MS + WALL_SPAN_MS);
  return {
    x: gap, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: A_MS, latestArrivalMs: A_MS + WALL_SPAN_MS,
    poseRing: ring, ringHead: 2, radius: 12, kind: 1, sleeping: false, lastUpdateTick: 0,
  };
}

/** Read at the bracket midpoint; returns the displayed x. */
function readMidX(gap: number): number {
  const out: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  const nowMs = A_MS + WALL_SPAN_MS / 2 + getSwarmDisplayDelayMs();
  return interpolateSwarmPose(entry(gap), nowMs, out).x;
}

describe('drone teleport guard uses game ms', () => {
  afterEach(() => { setSwarmDisplaySpeed(1); resetSwarmTickClock(); });

  it('at 2× a jump legit in game time is interpolated, not snapped', () => {
    setSwarmDisplaySpeed(2);
    setSwarmDisplayDelayMs(0);
    const gap = legitGap(WALL_SPAN_MS * 2);
    // Over the bound in wall ms: the old check would have snapped to `gap`.
    expect(gap).toBeGreaterThan(TELEPORT_MAX_PLAUSIBLE_SPEED * WALL_SPAN_MS / 1000);
    expect(readMidX(gap)).toBeCloseTo(gap / 2, 6);
  });

  it('at 2× a jump past the game-time bound still snaps', () => {
    setSwarmDisplaySpeed(2);
    setSwarmDisplayDelayMs(0);
    const gap = legitGap(WALL_SPAN_MS * 2) + 2;
    expect(readMidX(gap)).toBe(gap);
  });

  it('at 1× results are unchanged', () => {
    setSwarmDisplaySpeed(1);
    setSwarmDisplayDelayMs(0);
    const under = legitGap(WALL_SPAN_MS);
    expect(readMidX(under)).toBeCloseTo(under / 2, 6);
    const over = under + 2;
    expect(readMidX(over)).toBe(over);
  });
});
