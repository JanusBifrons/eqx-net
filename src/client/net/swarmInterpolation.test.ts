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
    ring[i] = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true };
  }
  return ring;
}

interface ArrivalSpec {
  x?: number;
  y?: number;
  angle?: number;
  vx?: number;
  vy?: number;
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

describe('Stage 0 constants', () => {
  it('DISPLAY_DELAY_MS = 50 ms (was 100; halves perceived remote-entity lag)', () => {
    // docs/FEEL_GOALS.md flagged 50 ms as achievable now that snapshot
    // arrival jitter is stable < 20 ms. Cutting from 100 → 50 halves the
    // visible lag of every interpolated swarm sprite.
    expect(DISPLAY_DELAY_MS).toBe(50);
  });

  it('ADAPTIVE_DELAY_CEILING_MS = 200 ms (was 350; jitter is < 20 ms in practice)', () => {
    // Ceiling drops 350 → 200 because measured snapshot jitter has been
    // stable below 20 ms — 4× headroom is plenty; 7× was unnecessary.
    expect(ADAPTIVE_DELAY_CEILING_MS).toBe(200);
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
