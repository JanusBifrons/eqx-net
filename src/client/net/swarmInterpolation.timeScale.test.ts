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
  setSwarmDisplayDelayMs, setSwarmDisplaySpeed, getSwarmDisplayDelayMs,
  DISPLAY_DELAY_MS, ADAPTIVE_DELAY_CEILING_MS,
} from './swarmInterpolation.js';
import { POSE_RING_DEPTH } from '../../core/contracts/IRenderer.js';
import { resolveMissileDisplayPose } from '../combat/MissileMirror.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';

describe('swarm display delay follows the sector speed (time scale 4b)', () => {
  afterEach(() => { setSwarmDisplaySpeed(1); setSwarmDisplayDelayMs(DISPLAY_DELAY_MS); });

  it('1× is unchanged: floor 100, ceiling 280', () => {
    setSwarmDisplayDelayMs(50);
    expect(getSwarmDisplayDelayMs()).toBe(DISPLAY_DELAY_MS);
    setSwarmDisplayDelayMs(1000);
    expect(getSwarmDisplayDelayMs()).toBe(ADAPTIVE_DELAY_CEILING_MS);
  });

  it('the pose ring covers the window at every speed (0.25–4×)', () => {
    for (const speed of [0.25, 0.5, 1, 2, 4]) {
      setSwarmDisplaySpeed(speed);
      setSwarmDisplayDelayMs(0); // the floor: the tightest case
      const posesInWindow = getSwarmDisplayDelayMs() * (60 * speed) / 1000;
      expect(posesInWindow, `speed ${speed}`).toBeLessThanOrEqual(POSE_RING_DEPTH);
      expect(posesInWindow, `speed ${speed}`).toBeCloseTo(6, 5); // 100 game ms = 6 ticks
    }
  });

  it('at 0.25× the window stretches: floor 400, ceiling 1,120 wall ms', () => {
    setSwarmDisplaySpeed(0.25);
    setSwarmDisplayDelayMs(0);
    expect(getSwarmDisplayDelayMs()).toBe(400);
    setSwarmDisplayDelayMs(5000);
    expect(getSwarmDisplayDelayMs()).toBe(1120);
  });

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
