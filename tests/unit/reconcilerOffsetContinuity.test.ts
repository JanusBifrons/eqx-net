/**
 * Local ship: does the drawn ship step on a second correction?
 * (netcode gap smoothing plan, section 3.3 and job S1-7; decides D9.)
 *
 * `Reconciler.reconcile` sets the new correction offset to
 * "physics before - physics after" and drops whatever is still left of the
 * previous offset. So when a second correction lands while the first one is
 * still easing out, the drawn ship (physics pose + `lerpOffset`) jumps by the
 * leftover part of the first offset.
 *
 * Setup, through the REAL Reconciler and a real PhysicsWorld:
 * - The ship is at rest at the origin and no inputs are buffered, and each
 *   snapshot is acked up to the current tick (ackedTick = currentTick - 1),
 *   so reconcile replays zero ticks: the physics pose after a correction is
 *   exactly the server pose. No physics motion happens at all, so the
 *   expected per-frame motion is zero and every bit of drawn movement is the
 *   correction offset.
 * - Correction 1 moves the server pose `firstErrorU` along +x. The drawn pose
 *   does not move at that instant (offset = before - after exactly cancels).
 * - The offset eases out on wall time (`advanceLerp`) for a number of
 *   60 Hz frames.
 * - Correction 2 moves the server pose a further `SECOND_ERROR_U` (1 u, a
 *   normal steady-state correction, above the 0.05 u threshold).
 * - The step is measured at the correction instant: drawn pose right after
 *   `reconcile` minus drawn pose right before it, at the same wall time, so
 *   the expected motion between the two readings is zero by construction.
 *
 * Why not `countMotionArtefacts` (tests/scenarios/assertions.ts): it scores
 * the drawn step against a true track, but here the physics pose itself is
 * the thing being corrected and jumps at every snapshot, so it is not a
 * usable truth track. The step is measured directly instead.
 *
 * Deterministic: a MockClock is passed to the Reconciler (it only reads the
 * clock for RTT), and spring time is fed explicitly through `advanceLerp`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld, type ShipPhysicsState } from '../../src/core/physics/World.js';
import { Reconciler } from '../../src/core/prediction/Reconciler.js';
import { MockClock } from '../../src/core/clock/Clock.js';

const PLAYER = 'continuity-probe';
/** One 60 Hz frame of wall time, ms. */
const FRAME_MS = 1000 / 60;
/** Snapshot spacing: server broadcasts every 50 ms = 3 frames. */
const SNAPSHOT_GAP_FRAMES = 3;
/** Size of the second correction (world units): steady-state jitter, above the 0.05 u threshold. */
const SECOND_ERROR_U = 1;
/** Small first error: inside the 25 ms half-life band (0.5..20 u). */
const SMALL_ERROR_U = 5;
/** Large first error: at the 220 ms half-life glide (>= 220 u). */
const LARGE_ERROR_U = 220;
/** Target: the drawn pose does not move at the correction instant. */
const NO_STEP_TOLERANCE_U = 1e-6;

interface StepResult {
  /** Half-life of the first correction, ms. */
  firstHalfLifeMs: number;
  /** First offset left at the moment of correction 2 (x, world units). */
  leftoverOffsetU: number;
  /** Drawn x right before correction 2. */
  drawnBeforeX: number;
  /** Drawn x right after correction 2. */
  drawnAfterX: number;
  /** |drawn after - drawn before| at the correction instant, world units. */
  stepU: number;
}

let world: PhysicsWorld;

beforeAll(async () => {
  world = await PhysicsWorld.create();
});

function serverPose(x: number): ShipPhysicsState {
  return { x, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
}

function drawnX(r: Reconciler): number {
  return world.getShipState(PLAYER)!.x + r.lerpOffset.x;
}

/**
 * Run correction 1 of `firstErrorU`, ease for `framesBetween` frames, then
 * correction 2 of SECOND_ERROR_U, and measure the drawn step at that instant.
 */
function runTwoCorrections(firstErrorU: number, framesBetween: number): StepResult {
  world.despawnShip(PLAYER);
  world.spawnShip(PLAYER, 0, 0);
  world.setShipState(PLAYER, serverPose(0));
  const r = new Reconciler(world, PLAYER, new MockClock(0));

  let tick = 1;
  // Correction 1. Zero replay ticks: physics after = server pose.
  r.reconcile(serverPose(firstErrorU), tick, tick, tick - 1);
  const firstHalfLifeMs = r.lerpHalfLifeMs;
  expect(r.isLerping).toBe(true);
  expect(drawnX(r)).toBeCloseTo(0, 9); // first correction itself is seamless

  for (let f = 0; f < framesBetween; f++) {
    r.advanceLerp(FRAME_MS);
    tick++;
  }
  expect(r.isLerping).toBe(true); // first correction still easing

  const leftoverOffsetU = r.lerpOffset.x;
  const drawnBeforeX = drawnX(r);
  // Correction 2, at the same wall time as the reading above.
  r.reconcile(serverPose(firstErrorU + SECOND_ERROR_U), tick, tick, tick - 1);
  const drawnAfterX = drawnX(r);

  return {
    firstHalfLifeMs,
    leftoverOffsetU,
    drawnBeforeX,
    drawnAfterX,
    stepU: Math.abs(drawnAfterX - drawnBeforeX),
  };
}

/**
 * Today's numbers (recorded 2026-11-21 on this branch). `todayStepU` is the
 * drawn jump at the instant of correction 2; it equals the leftover of the
 * first offset, whatever the size of the second correction.
 * - small: 5 u error, 25 ms half-life, 50 ms later: 0.759 u left (15.2%).
 * - large: 220 u error, 220 ms glide, 50 ms later: 207.538 u left (94.3%).
 * - large: 220 u error, 220 ms glide, 16.7 ms later: 218.365 u left (99.3%).
 */
const CASES = [
  {
    name: 'small error (25 ms half-life), second correction 50 ms later',
    firstErrorU: SMALL_ERROR_U,
    frames: SNAPSHOT_GAP_FRAMES,
    halfLifeMs: 25,
    todayStepU: 0.759,
  },
  {
    name: 'large error (220 ms glide), second correction 50 ms later',
    firstErrorU: LARGE_ERROR_U,
    frames: SNAPSHOT_GAP_FRAMES,
    halfLifeMs: 220,
    todayStepU: 207.538,
  },
  {
    name: 'large error (220 ms glide), second correction 16.7 ms later',
    firstErrorU: LARGE_ERROR_U,
    frames: 1,
    halfLifeMs: 220,
    todayStepU: 218.365,
  },
] as const;

/** Recorded numbers are locked to 3 decimals (world units). */
const RECORDED_DECIMALS = 3;

describe('Reconciler offset continuity: second correction while the first is easing (plan 3.3, S1-7)', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it(`recorded today: drawn ship steps ${c.todayStepU} u at the second correction`, () => {
        const res = runTwoCorrections(c.firstErrorU, c.frames);
        expect(res.firstHalfLifeMs).toBe(c.halfLifeMs);
        // The step is exactly the dropped leftover of the first offset.
        expect(res.stepU).toBeCloseTo(Math.abs(res.leftoverOffsetU), 9);
        // Drawn pose lands on the new physics pose minus the new offset only.
        expect(res.drawnAfterX).toBeCloseTo(c.firstErrorU, 9);
        expect(res.stepU).toBeCloseTo(c.todayStepU, RECORDED_DECIMALS);
      });

      // Target (plan 3.3 / 6.2): new offset = drawn before - physics after,
      // so the drawn pose does not move at the correction instant.
      // Fails today: step is the `todayStepU` above.
      it.fails(`no visible step on the second correction (today: ${c.todayStepU} u)`, () => {
        const res = runTwoCorrections(c.firstErrorU, c.frames);
        expect(res.stepU).toBeLessThan(NO_STEP_TOLERANCE_U);
      });
    });
  }
});
