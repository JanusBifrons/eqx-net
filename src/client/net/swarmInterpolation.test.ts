import { describe, it, expect } from 'vitest';
import { interpolateSwarmPose, EXTRAPOLATION_LIMIT_MS, type InterpolatedPose } from './swarmInterpolation.js';
import type { SwarmRenderState } from '../../core/contracts/IRenderer.js';

function entry(overrides: Partial<SwarmRenderState> = {}): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0,
    prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0,
    radius: 16, kind: 0, sleeping: false, lastUpdateTick: 0,
    ...overrides,
  };
}

const out: InterpolatedPose = { x: 0, y: 0, angle: 0 };

describe('interpolateSwarmPose', () => {
  it('returns latest pose on first sighting (prev == latest)', () => {
    const e = entry({ x: 100, y: 200, prevX: 100, prevY: 200, prevArrivalMs: 1000, latestArrivalMs: 1000 });
    interpolateSwarmPose(e, 1500, out);
    expect(out.x).toBe(100);
    expect(out.y).toBe(200);
  });

  it('returns prev pose at t=0 (now == prevArrivalMs)', () => {
    const e = entry({ x: 100, y: 0, prevX: 0, prevY: 0, prevArrivalMs: 1000, latestArrivalMs: 1100 });
    interpolateSwarmPose(e, 1000, out);
    expect(out.x).toBeCloseTo(0, 5);
    expect(out.y).toBeCloseTo(0, 5);
  });

  it('returns latest pose at t=1 (now == latestArrivalMs)', () => {
    const e = entry({ x: 100, y: 0, prevX: 0, prevY: 0, prevArrivalMs: 1000, latestArrivalMs: 1100 });
    interpolateSwarmPose(e, 1100, out);
    expect(out.x).toBeCloseTo(100, 5);
  });

  it('linearly interpolates at t=0.5', () => {
    const e = entry({ x: 100, y: 50, prevX: 0, prevY: 0, prevArrivalMs: 1000, latestArrivalMs: 1100 });
    interpolateSwarmPose(e, 1050, out);
    expect(out.x).toBeCloseTo(50, 5);
    expect(out.y).toBeCloseTo(25, 5);
  });

  it('extrapolates with vx/vy past latest (within EXTRAPOLATION_LIMIT_MS)', () => {
    const e = entry({ x: 100, y: 0, vx: 200, vy: 0, prevArrivalMs: 1000, latestArrivalMs: 1100 });
    // 50 ms past latest → +200u/s × 0.05s = +10u.
    interpolateSwarmPose(e, 1150, out);
    expect(out.x).toBeCloseTo(110, 4);
  });

  it('caps extrapolation at EXTRAPOLATION_LIMIT_MS (no runaway)', () => {
    const e = entry({ x: 100, y: 0, vx: 200, vy: 0, prevArrivalMs: 1000, latestArrivalMs: 1100 });
    // 500 ms past latest, way over the 100 ms cap. Result clamped.
    interpolateSwarmPose(e, 1600, out);
    const clamped = 100 + 200 * (EXTRAPOLATION_LIMIT_MS / 1000);
    expect(out.x).toBeCloseTo(clamped, 4);
  });

  it('sleeping entries skip interpolation entirely', () => {
    const e = entry({ x: 100, y: 0, prevX: 0, prevY: 0, prevArrivalMs: 1000, latestArrivalMs: 1100, sleeping: true });
    interpolateSwarmPose(e, 1050, out);
    expect(out.x).toBe(100);
  });

  it('angle interpolation takes the shortest arc across the +π/−π wrap', () => {
    const e = entry({
      angle: -Math.PI + 0.1, // just past −π, equivalent to ~+π again
      prevAngle: Math.PI - 0.1, // just before +π
      prevArrivalMs: 1000,
      latestArrivalMs: 1100,
    });
    interpolateSwarmPose(e, 1050, out);
    // Shortest arc: prevAngle → angle is +0.2 rad across the wrap.
    // At t=0.5 the angle should be either close to ±π (small magnitude excess
    // either side); definitely not 0 (which is what naive lerp would give).
    expect(Math.abs(out.angle)).toBeGreaterThan(Math.PI - 0.1);
  });

  it('clamps t to [0, 1] inside the interpolation window', () => {
    const e = entry({ x: 100, prevX: 0, prevArrivalMs: 1000, latestArrivalMs: 1100 });
    // Way before prev arrival: t would be negative; should clamp to 0.
    interpolateSwarmPose(e, 800, out);
    expect(out.x).toBeCloseTo(0, 5);
  });
});
