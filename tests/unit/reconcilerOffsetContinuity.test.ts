/**
 * Local ship: does the drawn ship step on a second correction?
 * (netcode gap smoothing plan, section 3.3 and job S1-7; decides D9.)
 *
 * Before S2b-1, `Reconciler.reconcile` set the new correction offset to
 * "physics before - physics after" and dropped whatever was still left of
 * the previous offset, so a second correction landing while the first was
 * still easing out made the drawn ship (physics pose + `lerpOffset`) jump by
 * that leftover. The offset now carries the leftover over (continuous).
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
/** Frames eased after correction 2 when measuring the glide (500 ms). */
const GLIDE_FRAMES = 30;
/**
 * Glide bound: after correction 2, the drawn ship moves no faster per frame
 * than the first correction would have on its own (same error, never
 * interrupted), plus 5 %. The carried offset is at most first error + second
 * error and gets the half-life of that size, so its peak speed matches the
 * uninterrupted glide's; a 25 ms half-life on the carried ~208 u (the bug
 * this locks out) moved 64-72 u per frame against a ~10.3 u peak.
 */
const GLIDE_PEAK_SLACK = 1.05;

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
  /** Half-life chosen for correction 2, ms. */
  secondHalfLifeMs: number;
  /** Largest per-frame drawn move over GLIDE_FRAMES after correction 2. */
  maxMoveAfterU: number;
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
  const secondHalfLifeMs = r.lerpHalfLifeMs;
  const maxMoveAfterU = maxPerFrameMove(r, GLIDE_FRAMES);

  return {
    firstHalfLifeMs,
    leftoverOffsetU,
    drawnBeforeX,
    drawnAfterX,
    stepU: Math.abs(drawnAfterX - drawnBeforeX),
    secondHalfLifeMs,
    maxMoveAfterU,
  };
}

/** Ease for `frames` 60 Hz frames; largest |drawn x change| in one frame. */
function maxPerFrameMove(r: Reconciler, frames: number): number {
  let prev = drawnX(r);
  let max = 0;
  for (let f = 0; f < frames; f++) {
    r.advanceLerp(FRAME_MS);
    const x = drawnX(r);
    max = Math.max(max, Math.abs(x - prev));
    prev = x;
  }
  return max;
}

/** Peak per-frame drawn move of one uninterrupted correction of `errorU`. */
function singleGlidePeakU(errorU: number): number {
  world.despawnShip(PLAYER);
  world.spawnShip(PLAYER, 0, 0);
  world.setShipState(PLAYER, serverPose(0));
  const r = new Reconciler(world, PLAYER, new MockClock(0));
  r.reconcile(serverPose(errorU), 1, 1, 0);
  return maxPerFrameMove(r, GLIDE_FRAMES);
}

/**
 * Numbers recorded 2026-11-21. `leftoverU` is the first offset still in
 * effect at the instant of correction 2. Before the continuity fix (S2b-1)
 * the drawn ship jumped by exactly this much; after it, the jump is 0.
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
    leftoverU: 0.759,
  },
  {
    name: 'large error (220 ms glide), second correction 50 ms later',
    firstErrorU: LARGE_ERROR_U,
    frames: SNAPSHOT_GAP_FRAMES,
    halfLifeMs: 220,
    leftoverU: 207.538,
  },
  {
    name: 'large error (220 ms glide), second correction 16.7 ms later',
    firstErrorU: LARGE_ERROR_U,
    frames: 1,
    halfLifeMs: 220,
    leftoverU: 218.365,
  },
] as const;

/** Recorded numbers are locked to 3 decimals (world units). */
const RECORDED_DECIMALS = 3;

describe('Reconciler offset continuity: second correction while the first is easing (plan 3.3, S1-7)', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it(`recorded: ${c.leftoverU} u of the first offset left at the second correction`, () => {
        const res = runTwoCorrections(c.firstErrorU, c.frames);
        expect(res.firstHalfLifeMs).toBe(c.halfLifeMs);
        // Before the fix the drawn ship stepped by exactly this leftover.
        expect(Math.abs(res.leftoverOffsetU)).toBeCloseTo(c.leftoverU, RECORDED_DECIMALS);
      });

      // Plan 3.3 / 6.2: new offset = (physics before + offset still in
      // effect) - physics after, so the drawn pose does not move at the
      // correction instant. Before the fix: step = `leftoverU` above.
      it(`no visible step on the second correction (before the fix: ${c.leftoverU} u)`, () => {
        const res = runTwoCorrections(c.firstErrorU, c.frames);
        expect(res.stepU).toBeLessThan(NO_STEP_TOLERANCE_U);
        expect(res.drawnAfterX).toBeCloseTo(res.drawnBeforeX, 9);
      });

      // Owner decision (D9 follow-up): correction 2's half-life comes from
      // max(carried offset, raw drift), so a large leftover keeps gliding.
      it('the carried offset keeps gliding: no frame faster than the first correction alone', () => {
        const peakAloneU = singleGlidePeakU(c.firstErrorU);
        const res = runTwoCorrections(c.firstErrorU, c.frames);
        expect(res.secondHalfLifeMs).toBeGreaterThanOrEqual(res.firstHalfLifeMs * 0.9);
        expect(res.maxMoveAfterU).toBeLessThanOrEqual(peakAloneU * GLIDE_PEAK_SLACK);
      });
    });
  }
});
