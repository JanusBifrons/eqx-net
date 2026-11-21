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
  stepSwarmDisplayDelay, resetSwarmTickClock,
  DISPLAY_DELAY_MS, ADAPTIVE_DELAY_CEILING_MS, DISPLAY_DELAY_SLEW_MAX_RATE,
} from './swarmInterpolation.js';
import { POSE_RING_DEPTH } from '../../core/contracts/IRenderer.js';
import { resolveMissileDisplayPose } from '../combat/MissileMirror.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';

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
