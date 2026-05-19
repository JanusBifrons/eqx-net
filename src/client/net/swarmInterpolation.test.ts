import { describe, it, expect } from 'vitest';
import {
  interpolateSwarmPose,
  EXTRAPOLATION_LIMIT_MS,
  DISPLAY_DELAY_MS,
  ADAPTIVE_DELAY_CEILING_MS,
  type InterpolatedPose,
} from './swarmInterpolation.js';
import type { SwarmRenderState, PoseRingEntry } from '../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../core/contracts/IRenderer.js';

function emptyRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = new Array(POSE_RING_DEPTH);
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring[i] = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true };
  }
  return ring;
}

interface ArrivalSpec {
  x?: number;
  y?: number;
  angle?: number;
  vx?: number;
  vy?: number;
  angvel?: number;
  arrivalMs: number;
}

function entryWithArrivals(arrivals: ArrivalSpec[], overrides: Partial<SwarmRenderState> = {}): SwarmRenderState {
  const ring = emptyRing();
  arrivals.forEach((a, i) => {
    const slot = ring[i % POSE_RING_DEPTH]!;
    slot.x = a.x ?? 0;
    slot.y = a.y ?? 0;
    slot.angle = a.angle ?? 0;
    slot.vx = a.vx ?? 0;
    slot.vy = a.vy ?? 0;
    slot.angvel = a.angvel ?? 0;
    slot.arrivalMs = a.arrivalMs;
    slot.serverTick = i;
    slot.empty = false;
  });
  const newest = arrivals[arrivals.length - 1]!;
  return {
    x: newest.x ?? 0, y: newest.y ?? 0, vx: newest.vx ?? 0, vy: newest.vy ?? 0, angle: newest.angle ?? 0,
    prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: newest.arrivalMs,
    poseRing: ring,
    ringHead: arrivals.length % POSE_RING_DEPTH,
    radius: 16, kind: 0, sleeping: false, lastUpdateTick: 0,
    ...overrides,
  };
}

const out: InterpolatedPose = { x: 0, y: 0, angle: 0 };

describe('drone snapshot-interpolation constants (Step 4, 2026-05-18 pivot)', () => {
  it('DISPLAY_DELAY_MS = 100 ms (the deliberate "render the past" feel buffer)', () => {
    // The pivot retired client drone AI re-sim: drones are now PURE
    // snapshot-interpolated off the decoder poseRing, and the predWorld
    // drone body is a kinematic follower of that SAME interpolated pose.
    // Render and collision are the identical pose by construction, so the
    // 2026-05-09 "0 ms to align render with predWorld collision" rationale
    // no longer applies. 100 ms backward-buffers the in-interest combat
    // cadence (~per server tick) so two bracketing samples essentially
    // always exist — a true lerp of buffered authoritative truth, immune
    // to wire jitter ≤ 100 ms. Industry standard (Quake/Source/Overwatch).
    expect(DISPLAY_DELAY_MS).toBe(100);
  });

  it('ADAPTIVE_DELAY_CEILING_MS = 280 ms (covers decimated out-of-interest drones)', () => {
    // Raised 200 → 280: an out-of-interest decimated drone arrives every
    // ~100–170 ms; the adaptive feed sizes the buffer at
    // binaryInterArrivalEwma × 1.5, so a 170 ms cadence wants ~255 ms to
    // still bracket two samples. 280 leaves headroom; the in-interest
    // combat pack sits at the 100 ms floor, nowhere near this.
    expect(ADAPTIVE_DELAY_CEILING_MS).toBe(280);
  });
});

describe('interpolateSwarmPose (display-delay buffer)', () => {
  it('returns oldest pose when only one arrival exists', () => {
    const e = entryWithArrivals([{ x: 100, y: 200, arrivalMs: 1000 }]);
    interpolateSwarmPose(e, 1500, out);
    expect(out.x).toBe(100);
    expect(out.y).toBe(200);
  });

  it('reads at now - DISPLAY_DELAY_MS', () => {
    // Two arrivals 50 ms apart. Render at nowMs = 1200; targetMs = 1100.
    // Linear: t = (1100 - 1050) / (1100 - 1050) = 1.0 → exactly the newer pose.
    const e = entryWithArrivals([
      { x: 0,   y: 0, arrivalMs: 1050 },
      { x: 100, y: 0, arrivalMs: 1100 },
    ]);
    interpolateSwarmPose(e, 1100 + DISPLAY_DELAY_MS, out);
    expect(out.x).toBeCloseTo(100, 5);
  });

  it('linearly interpolates between the two bracketing arrivals', () => {
    const e = entryWithArrivals([
      { x: 0,   arrivalMs: 1000 },
      { x: 100, arrivalMs: 1100 },
    ]);
    // targetMs = nowMs - 100 = 1050 → midway between 1000 and 1100.
    interpolateSwarmPose(e, 1050 + DISPLAY_DELAY_MS, out);
    expect(out.x).toBeCloseTo(50, 5);
  });

  it('selects the correct bracket from a 3-deep ring', () => {
    const e = entryWithArrivals([
      { x: 0,   arrivalMs: 1000 },
      { x: 100, arrivalMs: 1100 },
      { x: 200, arrivalMs: 1200 },
    ]);
    // targetMs = 1150 → bracket is (1100, 1200), t = 0.5 → x = 150.
    interpolateSwarmPose(e, 1150 + DISPLAY_DELAY_MS, out);
    expect(out.x).toBeCloseTo(150, 5);
  });

  it('clamps to oldest pose when render time precedes the buffer', () => {
    const e = entryWithArrivals([
      { x: 0,   arrivalMs: 1000 },
      { x: 100, arrivalMs: 1100 },
    ]);
    // targetMs = 800, before oldest. Should pin at oldest.
    interpolateSwarmPose(e, 800 + DISPLAY_DELAY_MS, out);
    expect(out.x).toBeCloseTo(0, 5);
  });

  it('extrapolates past newest arrival within EXTRAPOLATION_LIMIT_MS', () => {
    const e = entryWithArrivals([
      { x: 0,   arrivalMs: 1000 },
      { x: 100, vx: 200, arrivalMs: 1100 },
    ]);
    // targetMs = 1150, 50 ms past newest, with vx=200 → +10u → 110.
    interpolateSwarmPose(e, 1150 + DISPLAY_DELAY_MS, out);
    expect(out.x).toBeCloseTo(110, 4);
  });

  it('caps extrapolation at EXTRAPOLATION_LIMIT_MS', () => {
    const e = entryWithArrivals([
      { x: 0,   arrivalMs: 1000 },
      { x: 100, vx: 200, arrivalMs: 1100 },
    ]);
    // targetMs = 1600, 500 ms past newest. Capped to 100 ms → +20u → 120.
    interpolateSwarmPose(e, 1600 + DISPLAY_DELAY_MS, out);
    expect(out.x).toBeCloseTo(100 + 200 * (EXTRAPOLATION_LIMIT_MS / 1000), 4);
  });

  it('sleeping entries skip interpolation entirely', () => {
    const e = entryWithArrivals(
      [{ x: 0, arrivalMs: 1000 }, { x: 100, arrivalMs: 1100 }],
      { sleeping: true, x: 100 },
    );
    interpolateSwarmPose(e, 1050 + DISPLAY_DELAY_MS, out);
    expect(out.x).toBe(100);
  });

  it('angle interpolation takes the shortest arc across the +π/−π wrap', () => {
    const e = entryWithArrivals([
      { angle: Math.PI - 0.1, arrivalMs: 1000 },
      { angle: -Math.PI + 0.1, arrivalMs: 1100 },
    ]);
    interpolateSwarmPose(e, 1050 + DISPLAY_DELAY_MS, out);
    expect(Math.abs(out.angle)).toBeGreaterThan(Math.PI - 0.1);
  });

  it('stays smooth under ±30 ms arrival jitter (jitter mitigation)', () => {
    // 20 units per arrival, nominally 50 ms apart → real velocity 400 u/s
    // → ideal per-frame x-delta = 400 × 16.67/1000 ≈ 6.67 u/frame.
    // Inter-arrival times jitter ±30 ms (matches the user's capture). The
    // buffer's value: motion is *always* advancing (no freezes — the legacy
    // "delta = 0 then delta >> 0" freeze-burst pattern is gone) and bounded
    // by ~2× the ideal per-frame delta. A residual ±25 % velocity ripple
    // leaks through because bracketing arrivals span variable time windows;
    // arrival-grid resampling would flatten that further but is out of scope
    // for the buffer-only fix. The user-visible freeze-burst is what this
    // test guards against.
    const arrivals = [
      { x:   0, vx: 400, arrivalMs: 1000 },
      { x:  20, vx: 400, arrivalMs: 1080 },
      { x:  40, vx: 400, arrivalMs: 1130 },
      { x:  60, vx: 400, arrivalMs: 1170 },
      { x:  80, vx: 400, arrivalMs: 1230 },
      { x: 100, vx: 400, arrivalMs: 1280 },
      { x: 120, vx: 400, arrivalMs: 1330 },
      { x: 140, vx: 400, arrivalMs: 1380 },
      { x: 160, vx: 400, arrivalMs: 1430 },
      { x: 180, vx: 400, arrivalMs: 1480 },
    ];
    const e = entryWithArrivals(arrivals.slice(0, 1));
    let nextArrivalIdx = 1;
    const renderStart = 1100;
    let lastX: number | null = null;
    let maxDelta = 0;
    let minDelta = Infinity;
    for (let i = 0; i < 30; i++) {
      const nowMs = renderStart + i * 16.67;
      // Push every arrival the wire would have delivered by `nowMs`.
      while (nextArrivalIdx < arrivals.length && arrivals[nextArrivalIdx]!.arrivalMs <= nowMs) {
        const a = arrivals[nextArrivalIdx]!;
        const slot = e.poseRing[e.ringHead]!;
        slot.x = a.x; slot.y = 0; slot.angle = 0;
        slot.vx = a.vx; slot.vy = 0;
        slot.arrivalMs = a.arrivalMs;
        slot.serverTick = nextArrivalIdx;
        slot.empty = false;
        e.ringHead = (e.ringHead + 1) % POSE_RING_DEPTH;
        nextArrivalIdx++;
      }
      interpolateSwarmPose(e, nowMs, out);
      if (lastX !== null) {
        const delta = Math.abs(out.x - lastX);
        if (delta > maxDelta) maxDelta = delta;
        if (delta < minDelta) minDelta = delta;
      }
      lastX = out.x;
    }
    expect(minDelta).toBeGreaterThan(1); // no freezes
    expect(maxDelta).toBeLessThan(14);   // bounded ripple (~2× the 6.67 ideal)
  });
});

describe('extrapolation dead-reckon glides angle by angvel (Step 4, 2026-05-18)', () => {
  // Post-pivot, out-of-interest decimated drones (≈100–170 ms cadence)
  // frequently render in the past-the-newest extrapolation window. A
  // maneuvering drone is usually turning, so the dead-reckon must glide
  // the ANGLE by `angvel·dt` (not freeze it then snap on the next
  // decimated packet — that reads as a turret/heading stutter). Wire v3
  // carries angvel; the decoder fills every ring slot. (These tests don't
  // call setSwarmDisplayDelayMs, so the effective delay is the module's
  // DISPLAY_DELAY_MS floor; render times add it so targetMs lands where
  // intended — same pattern as the buffer tests above.)
  it('angle advances by angvel·dt within EXTRAPOLATION_LIMIT_MS (x/y still glide too)', () => {
    const e = entryWithArrivals([
      { x: 0,  y: 0, angle: 0.5, vx: 200, vy: 0, angvel: 2.0, arrivalMs: 1000 },
      { x: 10, y: 0, angle: 0.5, vx: 200, vy: 0, angvel: 2.0, arrivalMs: 1100 },
    ]);
    // 50 ms past the newest arrival → dt = 0.05.
    interpolateSwarmPose(e, 1150 + DISPLAY_DELAY_MS, out);
    expect(out.angle).toBeCloseTo(0.5 + 2.0 * 0.05, 6); // glided, NOT frozen at 0.5
    expect(out.x).toBeCloseTo(10 + 200 * 0.05, 4);      // position still dead-reckons
  });

  it('angle glide is capped at EXTRAPOLATION_LIMIT_MS (same cap as position)', () => {
    const e = entryWithArrivals([
      { x: 0, y: 0, angle: 0.5, vx: 0, vy: 0, angvel: 2.0, arrivalMs: 1000 },
      { x: 0, y: 0, angle: 0.5, vx: 0, vy: 0, angvel: 2.0, arrivalMs: 1100 },
    ]);
    // 500 ms past newest — overshoot clamps to EXTRAPOLATION_LIMIT_MS.
    interpolateSwarmPose(e, 1600 + DISPLAY_DELAY_MS, out);
    expect(out.angle).toBeCloseTo(0.5 + 2.0 * (EXTRAPOLATION_LIMIT_MS / 1000), 6);
  });

  it('zero angvel ⇒ angle is held (no spurious drift for non-rotating drones)', () => {
    const e = entryWithArrivals([
      { x: 0, y: 0, angle: 1.23, vx: 50, vy: 0, angvel: 0, arrivalMs: 1000 },
      { x: 5, y: 0, angle: 1.23, vx: 50, vy: 0, angvel: 0, arrivalMs: 1100 },
    ]);
    interpolateSwarmPose(e, 1180 + DISPLAY_DELAY_MS, out);
    expect(out.angle).toBeCloseTo(1.23, 6);
  });
});
