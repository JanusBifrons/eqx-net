/**
 * Drone snapshot-interpolation regression lock (the drone-netcode pivot).
 *
 * Origin: 2026-05-18 mobile smoke captures (`…cfyb5r` / `…jh6tf6`) — inside a
 * ~25-drone hostile pack the client's lockstep re-sim spirals; over-budget
 * maneuvering drones dead-reckon 50–400 u and snap every snapshot
 * (unplayable). Plan `i-d-like-you-to-silly-penguin`: retire client drone AI
 * re-sim, render drones as PURE SNAPSHOT-INTERPOLATED entities (Quake/Source
 * model) through the existing `interpolateSwarmPose`.
 *
 * This is the deterministic, host-independent core lock for the new model
 * (`nowMs` injected — no wall clock). It asserts the two properties the pivot
 * must guarantee on the interpolation hot path:
 *
 *  (a) SMOOTHNESS — under realistic jittered + decimated + lossy arrival
 *      cadence (the real binary-swarm wire: in-interest ~per-tick, out-of-
 *      interest decimated 100–170 ms, occasional drop), the rendered pose has
 *      no per-frame teleport: bounded frame-to-frame delta, graceful
 *      glide-then-freeze on starvation. (GREEN on current interpolator — locks
 *      that Steps 3-4 don't regress it.)
 *
 *  (b) TELEPORT GUARD — on a hard server discontinuity (full-snapshot
 *      keyframe every 60 ticks, SET_POSITION, despawn+id-reuse, sleep→wake)
 *      the sprite must SNAP to the new pose, never lerp-streak across open
 *      space. The current predWorld path masks this (instantaneous
 *      setShipState); routing drones through the unconditional lerp EXPOSES
 *      it. **RED on current code** (no guard in `interpolateSwarmPose`) →
 *      drives Step 2's guard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  interpolateSwarmPose,
  setSwarmDisplayDelayMs,
  getSwarmDisplayDelayMs,
  DISPLAY_DELAY_MS,
  ADAPTIVE_DELAY_CEILING_MS,
  type InterpolatedPose,
} from '../../src/client/net/swarmInterpolation.js';
import type { SwarmRenderState, PoseRingEntry } from '../../src/core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../src/core/contracts/IRenderer.js';

function emptyRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = new Array(POSE_RING_DEPTH);
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring[i] = {
      x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0,
      arrivalMs: 0, serverTick: 0, sleeping: false, empty: true,
    };
  }
  return ring;
}

interface Pose { x: number; y: number; angle: number; vx?: number; vy?: number }

function freshEntry(): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyRing(),
    ringHead: 0,
    radius: 16, kind: 1, sleeping: false, lastUpdateTick: 0,
  } as unknown as SwarmRenderState;
}

let _tick = 0;
/** Replicates the decoder's ring write contract (BinarySwarmDecoder.ts:159-166
 *  + 143-144) so the lock exercises the SAME ring semantics the wire produces,
 *  with a fully injected arrival clock. */
function deliver(entry: SwarmRenderState, p: Pose, arrivalMs: number): void {
  const slot = entry.poseRing[entry.ringHead]!;
  slot.x = p.x; slot.y = p.y; slot.angle = p.angle;
  slot.vx = p.vx ?? 0; slot.vy = p.vy ?? 0; slot.angvel = 0;
  slot.arrivalMs = arrivalMs; slot.serverTick = ++_tick;
  slot.sleeping = false; slot.empty = false;
  entry.ringHead = (entry.ringHead + 1) % POSE_RING_DEPTH;
  entry.prevArrivalMs = entry.latestArrivalMs;
  entry.latestArrivalMs = arrivalMs;
  entry.x = p.x; entry.y = p.y; entry.angle = p.angle;
  entry.vx = p.vx ?? 0; entry.vy = p.vy ?? 0;
}

const out: InterpolatedPose = { x: 0, y: 0, angle: 0 };
const FRAME_MS = 1000 / 60;

beforeEach(() => {
  _tick = 0;
  setSwarmDisplayDelayMs(100); // deterministic fixed delay for the lock
});

describe('drone snapshot-interpolation — (a) smoothness under realistic wire cadence', () => {
  it('tracks a maneuvering drone (never pins/freezes) across jittered + decimated + lossy INTERLEAVED arrivals', () => {
    // NOTE: the original version of this test bulk-delivered every packet
    // THEN sampled, so the ring only held future-of-target poses and the
    // interpolator pinned to its oldest entry — a FROZEN sprite, whose
    // per-frame delta is ~0, "passed" a `max delta < 8` bound. That is the
    // exact canary-blindness that let the Step-4 pin-to-stale regression
    // through. Rewritten to deliver INTERLEAVED (packets arrive while
    // frames render — the production onMessage→render ordering) and to
    // assert TRACKING (a frozen/pinned sprite now FAILS).
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
    const D = getSwarmDisplayDelayMs();
    const entry = freshEntry();
    // A maneuvering drone on a curved path (the in-pack combat case),
    // ~1333 u/s tangential.
    const trueAt = (tMs: number): Pose => {
      const a = tMs / 600;
      return {
        x: Math.cos(a) * 800,
        y: Math.sin(a) * 800,
        angle: a,
        vx: -Math.sin(a) * (800 / 600) * 1000,
        vy: Math.cos(a) * (800 / 600) * 1000,
      };
    };

    // Interleaved driver: step render frames over [fromMs, toMs]; before
    // each frame, land every packet the wire would have delivered by `now`
    // — packet i at absolute server time `fromMs + i*cadenceMs` (+jitter),
    // carrying trueAt(that time), with optional dropped indices. Scores
    // tracking error vs trueAt(now − D) and the per-frame step stats.
    // `entry`/ring persist across phases (continuity); packet scheduling
    // is phase-local so a cadence change is clean.
    let lastOut: InterpolatedPose | null = null;
    const run = (
      fromMs: number, toMs: number, cadenceMs: number,
      jitter: (i: number) => number, drop: (i: number) => boolean,
    ): { maxErr: number; p50Step: number; maxStep: number } => {
      const steps: number[] = [];
      let maxErr = 0;
      let i = 0;
      lastOut = null;
      for (let now = fromMs; now <= toMs; now += FRAME_MS) {
        for (let srv = fromMs + i * cadenceMs; srv <= now; srv = fromMs + i * cadenceMs) {
          if (!drop(i)) deliver(entry, trueAt(srv), srv + jitter(i));
          i++;
        }
        if (now < fromMs + D + 3 * cadenceMs) continue; // prime the buffer
        interpolateSwarmPose(entry, now, out);
        const tgt = trueAt(now - D);
        maxErr = Math.max(maxErr, Math.hypot(out.x - tgt.x, out.y - tgt.y));
        if (lastOut) steps.push(Math.hypot(out.x - lastOut.x, out.y - lastOut.y));
        lastOut = { x: out.x, y: out.y, angle: out.angle };
      }
      steps.sort((a, b) => a - b);
      return { maxErr, p50Step: steps[steps.length >> 1] ?? 0, maxStep: steps[steps.length - 1] ?? 0 };
    };

    // Phase 1 — in-interest ~16 ms cadence, ±6 ms jitter, no loss (1.4 s).
    const p1 = run(0, 1400, 16, (i) => (i % 3 === 0 ? 6 : i % 2 === 0 ? -4 : 0), () => false);
    expect(p1.maxErr, `phase-1 tracking error ${p1.maxErr.toFixed(1)} u from where the drone actually was at now−${D}ms (frozen/pinned ⇒ hundreds of u)`).toBeLessThan(20);
    expect(p1.p50Step, `phase-1 p50 per-frame step ${p1.p50Step.toFixed(1)} u — a frozen sprite is ~0 here`).toBeGreaterThan(8);
    expect(p1.maxStep, `phase-1 max per-frame step ${p1.maxStep.toFixed(1)} u (no teleport)`).toBeLessThan(60);

    // Phase 2 — decimated ~150 ms cadence with one dropped packet
    // (out-of-interest). Larger bounded lag is acceptable by design; it
    // must still TRACK (not pin) and never cross-space teleport.
    const p2 = run(1600, 1600 + 2600, 150, () => 0, (i) => i === 6);
    // maxErr is the load-bearing assertion: a pinned/frozen ring (the
    // Step-4 regression) blows tracking error to many hundreds of u on
    // this 1333 u/s path; staying bounded proves it still TRACKS even
    // decimated+lossy. The per-frame step bound is only a "no cross-space
    // teleport" sanity — a deliberately-decimated out-of-interest drone
    // with a dropped packet legitimately catches up ~150 u in a frame
    // (accepted by design; the in-interest combat pack is phase 1). A
    // real teleport-streak / guard failure would be many hundreds+.
    expect(p2.maxErr, `phase-2 (decimated+loss) tracking error ${p2.maxErr.toFixed(1)} u (pinned/frozen ⇒ hundreds)`).toBeLessThan(320);
    expect(p2.maxStep, `phase-2 (decimated+loss) max per-frame step ${p2.maxStep.toFixed(1)} u (bounded catch-up, NOT a cross-space teleport-streak)`).toBeLessThan(400);
  });
});

describe('drone snapshot-interpolation — (b) teleport guard (GREEN, Step 2 lock)', () => {
  it('hard discontinuity SNAPS, never lerp-streaks across open space', () => {
    // Ask for 0 delay; post-Step-4 the hard floor clamps the effective
    // delay UP to DISPLAY_DELAY_MS, so read it back and offset the sample
    // window by it — keeps this lock exercising the SAME @16→@32 bracket
    // regardless of the floor value (the guard is delay-independent).
    setSwarmDisplayDelayMs(0);
    const D = getSwarmDisplayDelayMs();
    const entry = freshEntry();
    // Two near poses establish a normal interpolation window...
    deliver(entry, { x: 0, y: 0, angle: 0 }, 0);
    deliver(entry, { x: 5, y: 0, angle: 0 }, 16);
    // ...then a hard server discontinuity (keyframe / SET_POSITION / id-reuse):
    // a 7071 u jump. Without the guard, interpolateSwarmPose would lerp the
    // gap over the 16→32 ms bracket — the sprite flies across the sector.
    deliver(entry, { x: 5000, y: 5000, angle: 0 }, 32);

    // Sample every frame across the bracket window (offset by the effective
    // display delay so targetMs sweeps [16, 40]). EVERY sample must be at
    // one of the ring poses (a snap), never a far in-between lerp point.
    let worstMinDist = 0;
    for (let now = 16 + D; now <= 40 + D; now += 2) {
      interpolateSwarmPose(entry, now, out);
      const dPrev = Math.hypot(out.x - 5, out.y - 0);
      const dNew = Math.hypot(out.x - 5000, out.y - 5000);
      worstMinDist = Math.max(worstMinDist, Math.min(dPrev, dNew));
    }
    // The Step-2 guard marks the ring single-arrival on the discontinuity
    // so the sprite pins to the new pose (worstMinDist ≈ 0) instead of
    // gliding ~3500 u from BOTH poses mid-bracket.
    expect(
      worstMinDist,
      `teleport produced a lerp-streak: a render frame was ${worstMinDist.toFixed(0)} u from both the old and new pose (should snap, not glide across space)`,
    ).toBeLessThan(50);
  });
});

/**
 * Regression lock for the Step-4 smoke-test failure (cap
 * `2026-05-18T18-56-32-991Z-1fc0oe`): with `DISPLAY_DELAY_MS` raised to
 * 100 ms but `POSE_RING_DEPTH` left at 4, the interpolator's read point
 * (`now − 100 ms`) fell BEFORE the oldest of only 4 ring entries at the
 * in-interest binary cadence (~16.7 ms / server tick) — so every drone
 * pinned to a ~60 ms-stale pose and lurched one packet-of-motion every
 * 16 ms. The kinematic predWorld follower then drove the drone COLLISION
 * bodies to that lurching pose inside the player's prediction world, so
 * the player ship jumped and client beam geometry lagged too.
 *
 * The pre-existing smoothness lock (a) was blind to this: it asserts
 * BOUNDED per-frame delta, which a pinned/frozen sprite trivially
 * satisfies, and it bulk-delivers all arrivals THEN samples (the ring is
 * static during sampling). These locks instead deliver INTERLEAVED (the
 * real wire: packets arrive while frames render) and assert TRACKING
 * ACCURACY — the rendered pose must stay near where the entity actually
 * was at `now − effectiveDelay`, i.e. it must NOT pin to a stale ring
 * tail.
 */
const BINARY_INTERARRIVAL_MS = 1000 / 60; // in-interest = per server tick

describe('drone snapshot-interpolation — (c) liveness: tracks, never pins, at the in-interest binary cadence', () => {
  it('rendered pose tracks the entity at now−delay under a realistic ~16.7 ms interleaved stream', () => {
    // Production delay floor (Step 4). Read back the clamped effective
    // value so the expected target uses the real delay.
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
    const D = getSwarmDisplayDelayMs();
    expect(D).toBe(DISPLAY_DELAY_MS); // floor is in effect

    const V = 600; // u/s — a fast drone (linear path ⇒ lerp is exact)
    const trueX = (tMs: number): number => (V * tMs) / 1000;

    const entry = freshEntry();
    let nextPkt = 0;
    let maxTrackErr = 0;
    let frozenRun = 0;
    let maxFrozenRun = 0;
    let lastOut: number | null = null;

    // 2 s of interleaved play: each render frame, first deliver every
    // binary packet the wire would have landed by `now` (≈ per server
    // tick), then read the interpolated pose — exactly the production
    // ordering (onMessage('swarm') decode, then per-frame render).
    for (let now = 0; now <= 2000; now += FRAME_MS) {
      while (nextPkt * BINARY_INTERARRIVAL_MS <= now) {
        const at = nextPkt * BINARY_INTERARRIVAL_MS;
        deliver(entry, { x: trueX(at), y: 0, angle: 0, vx: V, vy: 0 }, at);
        nextPkt++;
      }
      // Only score once the buffer should be primed (a correct ring has
      // ≥ 1 bracketing pair for `now − D`).
      if (now < D + 4 * BINARY_INTERARRIVAL_MS) { lastOut = null; continue; }
      interpolateSwarmPose(entry, now, out);
      maxTrackErr = Math.max(maxTrackErr, Math.abs(out.x - trueX(now - D)));
      if (lastOut !== null) {
        if (Math.abs(out.x - lastOut) < 1e-6) { frozenRun++; maxFrozenRun = Math.max(maxFrozenRun, frozenRun); }
        else frozenRun = 0;
      }
      lastOut = out.x;
    }

    // A correctly-sized ring lerps EXACTLY on a linear path (sub-unit
    // residual). A too-shallow ring pins to the stale oldest:
    // err ≈ V × (delay − ringSpan)/1000 ≈ 25–35 u here, AND the output
    // freezes between packet rotations (long zero-delta runs).
    expect(
      maxTrackErr,
      `drone rendered ${maxTrackErr.toFixed(1)} u from where it actually was at now−${D}ms — the ring is too shallow for the display delay at the in-interest binary cadence (pin-to-stale-oldest)`,
    ).toBeLessThan(8);
    expect(
      maxFrozenRun,
      `rendered pose was frozen for ${maxFrozenRun} consecutive frames (pinned to a non-advancing ring tail, then lurching)`,
    ).toBeLessThan(3);
  });
});

describe('drone snapshot-interpolation — ring-sizing structural invariant', () => {
  it('POSE_RING_DEPTH covers DISPLAY_DELAY_MS at the fastest (in-interest) binary cadence', () => {
    // THE invariant Step 4 silently violated. The interpolator reads at
    // `now − delay`; for two bracketing samples to exist there, the ring
    // must hold ≥ ceil(delay / minInterArrival) packets, + headroom for
    // arrival jitter / a late packet evicting the one still needed. The
    // BINDING case is the in-interest combat cadence (~per server tick,
    // 1000/60 ms) at the delay FLOOR — that is exactly the regime that
    // broke on device. (The adaptive ceiling case is self-satisfying:
    // the delay only rises toward ADAPTIVE_DELAY_CEILING_MS when the
    // observed cadence is correspondingly SLOWER, so the ring still spans
    // it. We assert the floor/fast case, which does not self-satisfy.)
    const need = Math.ceil(DISPLAY_DELAY_MS / BINARY_INTERARRIVAL_MS) + 2;
    expect(
      POSE_RING_DEPTH,
      `POSE_RING_DEPTH=${POSE_RING_DEPTH} cannot hold DISPLAY_DELAY_MS=${DISPLAY_DELAY_MS}ms of history at the ${BINARY_INTERARRIVAL_MS.toFixed(1)}ms in-interest binary cadence (need >= ${need}). Raise the depth or this regresses to pin-to-stale-oldest.`,
    ).toBeGreaterThanOrEqual(need);
    // Sanity: ADAPTIVE_DELAY_CEILING_MS stays referenced so a future
    // ceiling hike re-reviews this invariant.
    expect(ADAPTIVE_DELAY_CEILING_MS).toBeGreaterThan(DISPLAY_DELAY_MS);
  });
});
