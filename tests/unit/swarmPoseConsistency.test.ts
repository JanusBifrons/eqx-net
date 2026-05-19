/**
 * CANARY — one swarm pose per frame; every consumer reads that one value.
 *
 * THE BUG (on-device 2026-05-19, HIGH priority; diagnostic capture
 * `2026-05-19T12-27-31-674Z-jfagww`; user: drones "jitter like two things
 * are fighting for their position" and the laser "jitters between the
 * target and where it's drawn"):
 *
 *   A drone's display pose was resolved by `interpolateSwarmPose`
 *   THREE-to-FOUR times per rendered frame, each at a different
 *   `performance.now()`:
 *     • `updateMirror` (ColyseusClient) @ now₂ → writes `entry.x/y/angle`
 *       and drives the predWorld collision body.
 *     • `buildLocalAimTargets` (LocalBeam) @ now₁ (tickPhysics, *earlier*
 *       in the frame) → the turret/laser aim bearing.
 *     • `PixiRenderer` sprite draw @ now₃ (render, *later*) → the sprite;
 *       under the 30 Hz worker gate, only every 2nd frame.
 *   now₁ < now₂ < now₃ by a variable, raf-jitter-amplified amount, so
 *   within ONE frame the sprite, the collision body and the beam
 *   occupied three slightly different positions. The drone's own laser
 *   beam reads the written `entry.x/y` while its sprite re-interpolated
 *   at now₃ ⇒ the beam visibly jittered against the sprite; the aim
 *   re-interpolated at now₁ ⇒ "two things fighting".
 *
 * THE INVARIANT this canary locks (the drone-snapshot-interpolation
 * pivot's stated rule, finally enforced — `src/client/CLAUDE.md`): the
 * pose is resolved EXACTLY ONCE per frame (in `updateMirror`) and every
 * consumer reads that one written `entry.x/y/angle`. Equivalently and
 * more strongly: **a consumer's resolved pose must NOT depend on the
 * `now` that consumer happens to observe** — because there is one
 * resolution per frame, not one per consumer.
 *
 * RED on the pre-fix code: `buildLocalAimTargets` called
 * `interpolateSwarmPose(sw, now, scratch)` itself, so its result tracked
 * whatever `now` it was handed (≠ `updateMirror`'s now) → the
 * now-independence + equals-written-entry assertions fail. GREEN after
 * routing it through `resolveDroneDisplayPose` (read the one written
 * pose). Reverting that seam swap re-fails this lock.
 *
 * `interpolateSwarmPose` itself is deliberately untouched — its
 * display-delay buffer / teleport guard / adaptive delay are guarded by
 * the separate `swarmInterpolation.smoothness.test.ts` canary, which
 * must stay green (this plan changes *who calls it, how many times*, not
 * the function).
 */
import { describe, it, expect } from 'vitest';
import { interpolateSwarmPose, type InterpolatedPose } from '../../src/client/net/swarmInterpolation.js';
import { resolveDroneDisplayPose } from '../../src/client/net/swarmDisplayPose.js';
import { buildLocalAimTargets } from '../../src/client/combat/LocalBeam.js';
import type { SwarmRenderState, PoseRingEntry } from '../../src/core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../src/core/contracts/IRenderer.js';

function emptyRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = new Array(POSE_RING_DEPTH);
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring[i] = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true };
  }
  return ring;
}

/** A drone with a moving poseRing. `entry.x/y/angle` start at the newest
 *  RAW authoritative sample (what the decoder writes), exactly like the
 *  real mirror entry before `updateMirror` runs for the frame. */
function movingDrone(arrivals: Array<{ x: number; y: number; angle: number; arrivalMs: number }>): SwarmRenderState {
  const ring = emptyRing();
  arrivals.forEach((a, i) => {
    const slot = ring[i % POSE_RING_DEPTH]!;
    slot.x = a.x; slot.y = a.y; slot.angle = a.angle;
    slot.vx = 0; slot.vy = 0; slot.angvel = 0;
    slot.arrivalMs = a.arrivalMs; slot.serverTick = i; slot.empty = false;
  });
  const newest = arrivals[arrivals.length - 1]!;
  return {
    x: newest.x, y: newest.y, vx: 0, vy: 0, angle: newest.angle,
    prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: newest.arrivalMs,
    poseRing: ring, ringHead: arrivals.length % POSE_RING_DEPTH,
    radius: 16, kind: 1, sleeping: false, lastUpdateTick: 0,
  };
}

/** Replicate `ColyseusClient.updateMirror` lines 2481-2484 EXACTLY: the
 *  ONE per-frame interpolation, written into the live entry fields. After
 *  this, `entry.x/y/angle` IS the frame's single resolved display pose
 *  (and the value the predWorld collision body is set to two lines
 *  later). */
function simulateUpdateMirror(entry: SwarmRenderState, frameNow: number): void {
  const s: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  interpolateSwarmPose(entry, frameNow, s);
  entry.x = s.x;
  entry.y = s.y;
  entry.angle = s.angle;
}

describe('swarm pose consistency — one resolution per frame, every consumer reads it', () => {
  // A genuinely moving drone: (0,0)→(1000,0) over 1 s = 1000 u/s. Below
  // TELEPORT_MAX_PLAUSIBLE_SPEED (2500) so interpolateSwarmPose really
  // lerps — the resolved pose is a strong function of `now`, which is
  // what makes a divergent-now bug observable.
  const arrivals = [
    { x: 0, y: 0, angle: 0, arrivalMs: 0 },
    { x: 1000, y: 0, angle: 1, arrivalMs: 1000 },
  ];

  it('the turret/laser aim reads the SINGLE per-frame pose updateMirror wrote', () => {
    const drone = movingDrone(arrivals);
    const swarm = new Map<number, SwarmRenderState>([[7, drone]]);

    // The frame: updateMirror resolves the pose ONCE at the frame's now.
    const frameNow = 1000;
    simulateUpdateMirror(drone, frameNow);
    const written = { x: drone.x, y: drone.y };

    // The aim consumer (tickPhysics-phase, earlier in the frame) must
    // yield exactly that one written pose. It takes NO `now` — it cannot
    // re-resolve at a divergent instant by construction (the pre-fix
    // 3-arg `(swarm, now, scratch)` form re-interpolated at `now` and
    // failed this with an 8 u gap = 8 ms raf skew × 1000 u/s).
    const scratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    const targets = buildLocalAimTargets(swarm, scratch);

    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe('swarm-7');
    expect(targets[0]!.x).toBeCloseTo(written.x, 6);
    expect(targets[0]!.y).toBeCloseTo(written.y, 6);
  });

  it('aim tracks the WRITTEN entry, not the wall clock — only updateMirror moves it', () => {
    const drone = movingDrone(arrivals);
    const swarm = new Map<number, SwarmRenderState>([[7, drone]]);
    const sc: InterpolatedPose = { x: 0, y: 0, angle: 0 };

    // Frame A: resolve once, read aim.
    simulateUpdateMirror(drone, 950);
    const aimA1 = buildLocalAimTargets(swarm, sc)[0]!;
    // Calling the aim AGAIN without re-resolving the frame must not move
    // it (no per-consumer clock dependence — the one-resolution rule).
    const aimA2 = buildLocalAimTargets(swarm, sc)[0]!;
    expect(aimA2.x).toBeCloseTo(aimA1.x, 6);
    expect(aimA1.x).toBeCloseTo(drone.x, 6); // == the written entry

    // Frame B: a NEW per-frame resolution (updateMirror at a later now)
    // — and ONLY that — advances the aim, in lockstep with the entry the
    // sprite/collision body also read. Single source, one mover.
    simulateUpdateMirror(drone, 1050);
    const aimB = buildLocalAimTargets(swarm, sc)[0]!;
    expect(aimB.x).toBeCloseTo(drone.x, 6);
    expect(aimB.x).toBeGreaterThan(aimA1.x); // moved with the new frame
  });

  it('sprite, aim, and collision body resolve to ONE pose for a moving drone across a jittery frame', () => {
    const drone = movingDrone(arrivals);
    const swarm = new Map<number, SwarmRenderState>([[7, drone]]);

    // Frame resolves once @ now₂; the collision body is set from the
    // written entry on the next line in real code (ColyseusClient
    // :2485-2490), so entry.x/y IS the collision pose.
    const now2 = 1000;
    simulateUpdateMirror(drone, now2);
    const collision = { x: drone.x, y: drone.y, angle: drone.angle };

    // Sprite consumer @ now₃ (render, later) — MUST go through the seam.
    const now3Scratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    const sprite = resolveDroneDisplayPose(drone, now3Scratch);

    // Aim consumer (tickPhysics phase, earlier in the frame).
    const aimScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    const aim = buildLocalAimTargets(swarm, aimScratch)[0]!;

    expect(sprite.x).toBeCloseTo(collision.x, 6);
    expect(sprite.y).toBeCloseTo(collision.y, 6);
    expect(sprite.angle).toBeCloseTo(collision.angle, 6);
    expect(aim.x).toBeCloseTo(collision.x, 6);
    expect(aim.y).toBeCloseTo(collision.y, 6);
    // And it is the display-delayed pose (behind the raw newest sample
    // 1000) — preserving the 0e24448 guarantee "aim == drawn, not the
    // ahead/authoritative pose".
    expect(collision.x).toBeLessThan(1000);
  });
});
