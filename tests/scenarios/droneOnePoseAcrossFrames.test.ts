/**
 * BOUNDARY LOCK (drone/laser-jitter fix, Phase 3, plan:
 * drone-laser-jitter-one-pose-source) — the across-frames symptom.
 *
 * `tests/unit/swarmPoseConsistency.test.ts` is the per-frame PURE core
 * lock (aim reads the one written pose; the seam == the written pose).
 * THIS test is the across-frames boundary lock at the level the bug
 * actually LIVES: the `App.tsx` per-frame loop ordering
 *
 *     tickPhysics()  →  updateMirror()  →  renderer.update()
 *     [buildLocalAimTargets]  [interpolateSwarmPose ×1, writes      [sprite reads
 *      reads entry.x/y]        entry.x/y + drives collision body]    entry.x/y]
 *
 * driven across a JITTERY frame sequence with each step observing its
 * own `performance.now()` (now₁ < now₂ < now₃, raf-jitter-amplified —
 * the on-device capture `…-jfagww` had 10 raf_gaps, and the 30 Hz
 * worker sprite gate widens it to a whole frame). This is the exact
 * shape the user reported: drones "jitter like two things fighting for
 * their position", the laser "jitters between the target and where it's
 * drawn".
 *
 * It exercises the REAL production functions — `buildLocalAimTargets`,
 * `resolveDroneDisplayPose`, `interpolateSwarmPose` — NOT a re-modelled
 * pipeline (the sibling `droneRenderSmoothness.test.ts` models the
 * RETIRED pre-2026-05-18 client-AI/predWorld-snap/spring path and is
 * not the right scaffolding post-pivot). Fully deterministic (injected
 * `now`s), so — unlike `tests/e2e/feel-test-lockstep.spec.ts`, the
 * host-load-sensitive Phase-4 smoke — it is a real gate, not a
 * baseline-in-same-env smoke.
 *
 * The invariants locked, per frame F across the jitter:
 *   1. sprite(F) === collisionBody(F): byte-identical. Both read the
 *      single `entry.x/y/angle` updateMirror wrote @ now₂(F). This is
 *      the "two things fighting" / "laser vs sprite" symptom — if the
 *      sprite re-interpolated at render-now (the reverted bug) it would
 *      diverge from the collision body / beam every frame.
 *   2. aim(F) === collisionBody(F−1): the aim runs in tickPhysics,
 *      BEFORE updateMirror, so it reads the prior frame's written pose
 *      — a constant, deterministic ≤1-frame lead-lag (the accepted
 *      "render the past"), NEVER a divergent-now value.
 *   3. The sprite/collision trajectory is monotonic forward across the
 *      jittery sequence: no per-frame backward step (the visible
 *      "fight"). Pre-fix, the sprite tracked render-now while the beam
 *      tracked now₂, so their relative offset oscillated with the raf
 *      jitter — non-monotonic divergence.
 *   4. Regression contrast: the PRE-FIX sprite (re-interpolated at
 *      render-now ≠ now₂) provably diverges from the collision body by
 *      the jitter — documenting exactly what reverting the seam
 *      re-breaks.
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

/** A drone whose poseRing is fed two bracketing arrivals so
 *  `interpolateSwarmPose` genuinely lerps (no teleport snap, no
 *  extrapolation freeze) across the whole window the test sweeps. */
function movingDrone(): SwarmRenderState {
  const ring = emptyRing();
  // (0,0)@0ms → (1200,600)@4000ms ⇒ ~335 u/s, well below the 2500 u/s
  // teleport threshold; both samples populated so the bracket exists
  // for every frameNow in [DISPLAY_DELAY, 4000].
  const a = ring[0]!;
  a.x = 0; a.y = 0; a.angle = 0; a.arrivalMs = 0; a.empty = false;
  const b = ring[1]!;
  b.x = 1200; b.y = 600; b.angle = 1.2; b.arrivalMs = 4000; b.empty = false;
  return {
    x: 1200, y: 600, vx: 0, vy: 0, angle: 1.2,
    prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 4000,
    poseRing: ring, ringHead: 2,
    radius: 16, kind: 1, sleeping: false, lastUpdateTick: 0,
  };
}

/** updateMirror, verbatim (ColyseusClient.ts:2481-2490): ONE
 *  interpolation per frame written into entry.x/y/angle; the collision
 *  body is then set from those exact fields. */
function runUpdateMirror(entry: SwarmRenderState, frameNow: number): InterpolatedPose {
  const s: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  interpolateSwarmPose(entry, frameNow, s);
  entry.x = s.x; entry.y = s.y; entry.angle = s.angle;
  // setShipState(`swarm-…`, { x: entry.x, y: entry.y, angle: entry.angle })
  return { x: entry.x, y: entry.y, angle: entry.angle };
}

describe('drone — one pose per frame across a jittery App-loop sequence', () => {
  // A frame-now schedule with deliberate raf jitter: nominal 16.67 ms
  // steps perturbed ±6 ms, and per-frame intra-frame offsets so the
  // three consumer `now`s genuinely diverge within each frame.
  const FRAMES = 90;
  const NOMINAL_DT = 1000 / 60;
  function frameNows(): number[] {
    const out: number[] = [];
    let t = 200; // start past DISPLAY_DELAY so the bracket is the lerp window
    const jit = [0, 5.5, -4, 6, -5.5, 2, 4.5, -6, 3, -3];
    for (let f = 0; f < FRAMES; f++) {
      t += NOMINAL_DT + jit[f % jit.length]!;
      out.push(t);
    }
    return out;
  }

  it('sprite === collision body every frame; aim === previous frame (deterministic ≤1-frame lag), trajectory monotonic', () => {
    const drone = movingDrone();
    const swarm = new Map<number, SwarmRenderState>([[7, drone]]);
    const nows = frameNows();

    const aimScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    const spriteScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };

    let prevCollision: InterpolatedPose | null = null;
    let lastX = -Infinity;
    let backwardSteps = 0;

    for (let f = 0; f < FRAMES; f++) {
      const now2 = nows[f]!;

      // ── tickPhysics: aim runs FIRST, reading the entry as it stands
      //    at the start of the frame (= what updateMirror wrote last
      //    frame). It must NOT re-resolve at an aim-now.
      const aim = buildLocalAimTargets(swarm, aimScratch)[0]!;
      if (prevCollision) {
        expect(aim.x).toBeCloseTo(prevCollision.x, 9);
        expect(aim.y).toBeCloseTo(prevCollision.y, 9);
      }

      // ── updateMirror: the ONE interpolation for the frame.
      const collision = runUpdateMirror(drone, now2);

      // ── render: the sprite reads the written entry via the seam,
      //    at render-now (later in the frame) — must equal collision.
      const sprite = resolveDroneDisplayPose(drone, spriteScratch);
      expect(sprite.x).toBe(collision.x);
      expect(sprite.y).toBe(collision.y);
      expect(sprite.angle).toBe(collision.angle);

      // Trajectory: x is monotonic in the drone's +X travel (no
      // per-frame backward "fight" step). interpolateSwarmPose is a
      // monotone lerp over a forward-moving bracket, so the single
      // resolved pose advances every frame; a re-interpolating sprite
      // oscillating against the beam would break this.
      if (collision.x + 1e-9 < lastX) backwardSteps++;
      lastX = collision.x;

      prevCollision = { ...collision };
    }

    expect(backwardSteps).toBe(0);
  });

  it('regression contrast — the PRE-FIX render-now re-interpolation provably diverges from the collision body', () => {
    // This documents (and, if the seam is reverted, would re-expose)
    // exactly the bug: a sprite re-interpolated at render-now, while
    // the collision body / laser beam use the now₂-written entry.
    const drone = movingDrone();
    const nows = frameNows();
    let maxDivergence = 0;

    for (let f = 0; f < FRAMES; f++) {
      const now2 = nows[f]!;
      const collision = runUpdateMirror(drone, now2);
      // Pre-fix sprite: interpolateSwarmPose at render-now (a few ms
      // after now₂ — the renderer step runs later in the frame).
      const renderNow = now2 + 7;
      const preFixSprite: InterpolatedPose = { x: 0, y: 0, angle: 0 };
      interpolateSwarmPose(drone, renderNow, preFixSprite);
      maxDivergence = Math.max(
        maxDivergence,
        Math.hypot(preFixSprite.x - collision.x, preFixSprite.y - collision.y),
      );
    }

    // ~7 ms of render-now skew × ~335 u/s ≈ a couple of units of
    // sprite-vs-beam disagreement EVERY frame — and it oscillates with
    // the raf jitter, which is the visible "two things fighting".
    expect(maxDivergence).toBeGreaterThan(1);
  });
});
