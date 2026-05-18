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
  it('no per-frame teleport across jittered + decimated + lossy arrivals', () => {
    const entry = freshEntry();
    // A maneuvering drone on a curved path (the in-pack combat case).
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
    // Phase 1: in-interest high cadence (~per server tick, ~16 ms) with ±6 ms
    // jitter. Phase 2: out-of-interest decimation (~150 ms) with one dropped
    // packet. Deliver up to a server time, then sample render frames behind it.
    let serverMs = 0;
    const sampleMaxStep = (untilMs: number, fromMs: number): { max: number; p50: number } => {
      const steps: number[] = [];
      let prev: InterpolatedPose | null = null;
      for (let now = fromMs; now <= untilMs; now += FRAME_MS) {
        interpolateSwarmPose(entry, now, out);
        if (prev) steps.push(Math.hypot(out.x - prev.x, out.y - prev.y));
        prev = { x: out.x, y: out.y, angle: out.angle };
      }
      steps.sort((a, b) => a - b);
      return { max: steps[steps.length - 1] ?? 0, p50: steps[steps.length >> 1] ?? 0 };
    };

    // Phase 1 — 1.2 s of ~16 ms jittered arrivals.
    for (let k = 0; k < 75; k++) {
      serverMs = k * 16 + (k % 3 === 0 ? 6 : k % 2 === 0 ? -4 : 0);
      deliver(entry, trueAt(k * 16), serverMs);
    }
    const p1 = sampleMaxStep(serverMs - 20, 200);
    expect(p1.max, `phase-1 max per-frame jump ${p1.max.toFixed(1)} u`).toBeLessThan(8);
    expect(p1.p50).toBeLessThan(2);

    // Phase 2 — decimated ~150 ms cadence with a dropped packet, then a stall.
    let base = serverMs;
    for (let k = 1; k <= 6; k++) {
      if (k === 4) continue; // dropped packet
      const sMs = base + k * 150;
      deliver(entry, trueAt(75 * 16 + k * 150), sMs);
    }
    const p2 = sampleMaxStep(base + 6 * 150 + 300, base + 80);
    // Decimated/lossy must still bound the jump — glide then freeze, never a
    // cross-space teleport. (Looser than phase 1: distant drone, larger gaps.)
    expect(p2.max, `phase-2 (decimated+loss) max jump ${p2.max.toFixed(1)} u`).toBeLessThan(40);
  });
});

describe('drone snapshot-interpolation — (b) teleport guard (RED until Step 2)', () => {
  it('hard discontinuity SNAPS, never lerp-streaks across open space', () => {
    setSwarmDisplayDelayMs(0);
    const entry = freshEntry();
    // Two near poses establish a normal interpolation window...
    deliver(entry, { x: 0, y: 0, angle: 0 }, 0);
    deliver(entry, { x: 5, y: 0, angle: 0 }, 16);
    // ...then a hard server discontinuity (keyframe / SET_POSITION / id-reuse):
    // a 7071 u jump. With no guard, interpolateSwarmPose lerps the gap over the
    // 16→32 ms bracket — the sprite visibly flies across the sector.
    deliver(entry, { x: 5000, y: 5000, angle: 0 }, 32);

    // Sample every frame across the bracket window. EVERY sample must be at
    // one of the ring poses (a snap), never a far in-between lerp point.
    let worstMinDist = 0;
    for (let now = 16; now <= 40; now += 2) {
      interpolateSwarmPose(entry, now, out);
      const dPrev = Math.hypot(out.x - 5, out.y - 0);
      const dNew = Math.hypot(out.x - 5000, out.y - 5000);
      worstMinDist = Math.max(worstMinDist, Math.min(dPrev, dNew));
    }
    // RED on current code: mid-bracket the lerp sits ~3500 u from BOTH poses.
    // GREEN after Step 2: the ring is marked single-arrival on the
    // discontinuity so the sprite pins to the new pose (worstMinDist ≈ 0).
    expect(
      worstMinDist,
      `teleport produced a lerp-streak: a render frame was ${worstMinDist.toFixed(0)} u from both the old and new pose (should snap, not glide across space)`,
    ).toBeLessThan(50);
  });
});
