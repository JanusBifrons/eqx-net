/**
 * Game time scale (stream step 4b): the display-delay window is GAME time.
 *
 * Load-bearing invariant (root/client CLAUDE.md, the Step-4 regression):
 * `POSE_RING_DEPTH` must cover the display delay at the in-interest binary
 * cadence. That cadence is 60 × speed per WALL second, so a fixed 100 wall ms
 * at 4× spans ~24 poses (> 10): drones pinned to a stale pose. In game ms the
 * window spans the same handful of poses at every speed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  setSwarmDisplayDelayMs, setSwarmDisplaySpeed, getSwarmDisplayDelayMs, getSwarmDisplayDelayTargetMs,
  stepSwarmDisplayDelay, resetSwarmTickClock, interpolateSwarmPose, getSwarmGlideLimitCount,
  DISPLAY_DELAY_MS, ADAPTIVE_DELAY_CEILING_MS, DISPLAY_DELAY_SLEW_MAX_RATE, EXTRAPOLATION_LIMIT_MS,
} from './swarmInterpolation.js';
import { POSE_RING_DEPTH } from '../../core/contracts/IRenderer.js';
import { resolveMissileDisplayPose } from '../combat/MissileMirror.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../core/contracts/IRenderer.js';

/** The glide limit before S4-1 (wall ms at 1×). */
const OLD_GLIDE_LIMIT_MS = 100;
/** Wall ms between the two seeded poses. */
const GLIDE_SAMPLE_SPACING_MS = 100;

/** A drone with two poses, the newest at `newestMs` moving at `vx`. */
function glideEntry(newestMs: number, newestX: number, vx: number): SwarmRenderState {
  const ring: PoseRingEntry[] = Array.from({ length: POSE_RING_DEPTH }, () => (
    { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true }
  ));
  Object.assign(ring[0]!, { x: 0, vx, arrivalMs: newestMs - GLIDE_SAMPLE_SPACING_MS, serverTick: 0, empty: false });
  Object.assign(ring[1]!, { x: newestX, vx, arrivalMs: newestMs, serverTick: 1, empty: false });
  return {
    x: newestX, y: 0, vx, vy: 0, angle: 0,
    prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: newestMs,
    poseRing: ring, ringHead: 2,
    radius: 16, kind: 1, sleeping: false, lastUpdateTick: 0,
  };
}

describe('swarm display delay follows the sector speed (time scale 4b)', () => {
  // The floor / ceiling clamp applies to the TARGET; the slewed value glides
  // to it (S3-2), so these read the target.
  afterEach(() => { setSwarmDisplaySpeed(1); resetSwarmTickClock(); });

  it('1× is unchanged: floor 100, ceiling 280', () => {
    setSwarmDisplayDelayMs(50);
    expect(getSwarmDisplayDelayTargetMs()).toBe(DISPLAY_DELAY_MS);
    expect(getSwarmDisplayDelayMs()).toBe(DISPLAY_DELAY_MS);
    setSwarmDisplayDelayMs(1000);
    expect(getSwarmDisplayDelayTargetMs()).toBe(ADAPTIVE_DELAY_CEILING_MS);
  });

  it('the pose ring covers the window at every speed (0.25–4×)', () => {
    for (const speed of [0.25, 0.5, 1, 2, 4]) {
      setSwarmDisplaySpeed(speed);
      setSwarmDisplayDelayMs(0); // the floor: the tightest case
      const posesInWindow = getSwarmDisplayDelayTargetMs() * (60 * speed) / 1000;
      expect(posesInWindow, `speed ${speed}`).toBeLessThanOrEqual(POSE_RING_DEPTH);
      expect(posesInWindow, `speed ${speed}`).toBeCloseTo(6, 5); // 100 game ms = 6 ticks
    }
  });

  it('at 0.25× the window stretches: floor 400, ceiling 1,120 wall ms', () => {
    setSwarmDisplaySpeed(0.25);
    setSwarmDisplayDelayMs(0);
    expect(getSwarmDisplayDelayTargetMs()).toBe(400);
    expect(getSwarmDisplayDelayMs()).toBe(400); // first set: placed at the target
    setSwarmDisplayDelayMs(5000);
    expect(getSwarmDisplayDelayTargetMs()).toBe(1120);
  });

  // S3-2: the slew in wall ms at a non-1× speed. 0.7× and 2× (nearest to the
  // plan's examples): the per-frame change stays within the bound, the value
  // converges to the speed-scaled target, and a speed change clamps the value
  // into the new floor/ceiling at once (it never sits outside them).
  for (const speed of [0.7, 2]) {
    it(`slew at ${speed}×: bounded per frame, converges to the scaled target`, () => {
      const frameMs = 1000 / 60;
      setSwarmDisplaySpeed(speed);
      setSwarmDisplayDelayMs(0);
      const floor = DISPLAY_DELAY_MS / speed;
      const ceiling = ADAPTIVE_DELAY_CEILING_MS / speed;
      expect(getSwarmDisplayDelayMs()).toBeCloseTo(floor, 9);
      setSwarmDisplayDelayMs(5000); // target: the scaled ceiling
      expect(getSwarmDisplayDelayTargetMs()).toBeCloseTo(ceiling, 9);
      let prev = getSwarmDisplayDelayMs();
      for (let i = 0; i < 60 * 20; i++) {
        stepSwarmDisplayDelay(frameMs);
        const v = getSwarmDisplayDelayMs();
        expect(Math.abs(v - prev)).toBeLessThanOrEqual(DISPLAY_DELAY_SLEW_MAX_RATE * frameMs + 1e-9);
        expect(v).toBeGreaterThanOrEqual(floor - 1e-9);
        expect(v).toBeLessThanOrEqual(ceiling + 1e-9);
        prev = v;
      }
      expect(getSwarmDisplayDelayMs()).toBe(getSwarmDisplayDelayTargetMs());
    });

    it(`speed change to ${speed}× clamps the slewed value into the new range`, () => {
      setSwarmDisplaySpeed(1);
      setSwarmDisplayDelayMs(DISPLAY_DELAY_MS); // value 100 at 1×
      setSwarmDisplayDelayMs(ADAPTIVE_DELAY_CEILING_MS);
      for (let i = 0; i < 60 * 20; i++) stepSwarmDisplayDelay(1000 / 60);
      expect(getSwarmDisplayDelayMs()).toBe(ADAPTIVE_DELAY_CEILING_MS); // 280 wall ms
      setSwarmDisplaySpeed(speed);
      const floor = DISPLAY_DELAY_MS / speed;
      const ceiling = ADAPTIVE_DELAY_CEILING_MS / speed;
      // 280 at 2× is above the new 140 ceiling: clamped at once. At 0.7× it is
      // inside [142.9, 400] and stays put. The target is the same 280 wall ms
      // input re-clamped to the new range (140 at 2×, 280 at 0.7×).
      const expected = Math.max(floor, Math.min(ceiling, ADAPTIVE_DELAY_CEILING_MS));
      expect(getSwarmDisplayDelayMs()).toBe(expected);
      expect(getSwarmDisplayDelayTargetMs()).toBe(expected);
    });
  }

  // S4-1: the glide (extrapolation) limit is GAME ms like the delay: 250 game
  // ms = 250 / speed wall ms. Inside it the drone glides on its velocity;
  // past it the pose freezes and the read counts as a glide-limit hold.
  for (const speed of [0.7, 2]) {
    it(`glide limit at ${speed}×: ${EXTRAPOLATION_LIMIT_MS} game ms = ${EXTRAPOLATION_LIMIT_MS} / ${speed} wall ms`, () => {
      const newestMs = 1100;
      const newestX = 100;
      const vx = 200;
      const msPerS = 1000;
      const slackMs = 1;
      const pastLimitMs = 500;
      setSwarmDisplaySpeed(speed);
      setSwarmDisplayDelayMs(0); // the floor, DISPLAY_DELAY_MS / speed wall ms
      const delayMs = getSwarmDisplayDelayMs();
      const limitWallMs = EXTRAPOLATION_LIMIT_MS / speed;
      const e = glideEntry(newestMs, newestX, vx);
      const out = { x: 0, y: 0, angle: 0 };
      const read = (pastNewestMs: number): number => interpolateSwarmPose(e, newestMs + pastNewestMs + delayMs, out).x;

      const before = getSwarmGlideLimitCount();
      // Just inside the limit: still gliding, no hold counted.
      expect(read(limitWallMs - slackMs)).toBeCloseTo(newestX + vx * (limitWallMs - slackMs) / msPerS, 4);
      expect(getSwarmGlideLimitCount()).toBe(before);
      // Past it: frozen at the limit, one hold counted.
      expect(read(limitWallMs + pastLimitMs)).toBeCloseTo(newestX + vx * limitWallMs / msPerS, 4);
      expect(getSwarmGlideLimitCount()).toBe(before + 1);
      // The old 100 ms limit no longer freezes it (100 < 250 / 2 = 125 wall ms).
      expect(read(limitWallMs - slackMs)).toBeGreaterThan(newestX + vx * OLD_GLIDE_LIMIT_MS / msPerS);
    });
  }

  it('missiles: the display delay is game ms (mirror.timeScale)', () => {
    const ring = Array.from({ length: 6 }, () => ({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true }));
    // Two samples 10 wall ms apart; x moves 0 → 10.
    Object.assign(ring[0]!, { x: 0, arrivalMs: 1000, empty: false });
    Object.assign(ring[1]!, { x: 10, arrivalMs: 1010, empty: false });
    const mirror = { missiles: new Map([[1, { x: 10, y: 0, angle: 0, lifePct: 1, poseRing: ring }]]) } as unknown as RenderMirror;
    // At 4× the delay is 25 wall ms: now = 1030 → target 1005, halfway.
    mirror.timeScale = 4;
    expect(resolveMissileDisplayPose(mirror, 1, 1030)!.x).toBeCloseTo(5, 5);
  });
});
