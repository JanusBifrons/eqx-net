/**
 * Phase 4 travel state: a sector-to-sector trip. The local ship accelerates
 * out along its heading, cruises at warp speed while the destination loads,
 * then (after the minimum trip time, once the destination is loaded) is placed
 * on approach and decelerates exactly onto its arrival point. The approach
 * jump is recorded for the sky; the end of the approach opens the
 * minimum-display gate (the ship then arrives for everyone).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient, travelApproach } from './ColyseusClient.js';
import { WARP_SPEED } from '../../core/physics/warpDrive.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { useUIStore } from '../state/store.js';
import type { ShipRenderState } from '@core/contracts/IRenderer';

interface Internals {
  updateMirror(now?: number): void;
  beginTravel(): void;
  endTravel(): void;
  clock: { now(): number };
  predWorld: PhysicsWorld | null;
  mirror: { ships: Map<string, ShipRenderState>; localPlayerId: string | null; travelling?: boolean; travelDeep?: boolean; travelJumpX?: number; travelJumpY?: number };
}

describe('the trip between sectors', () => {
  beforeEach(() => { useUIStore.setState({ firstSnapshotApplied: false, joinMinimumElapsed: false, travelling: true }); });

  it('accelerates out, cruises at warp speed, then flies in onto the arrival point', async () => {
    const c = new ColyseusGameClient() as unknown as Internals;
    let t = 1000;
    c.clock = { now: () => t };
    c.mirror.localPlayerId = 'me';
    // Facing +x in game space: nose = (-sin a, cos a) = (1, 0) => a = -π/2.
    c.mirror.ships.set('me', { x: 100, y: 50, vx: 0, vy: 0, angle: -Math.PI / 2 });
    c.beginTravel();
    expect(c.mirror.travelling).toBe(true);
    const e = c.mirror.ships.get('me')!;

    // Out: slow at first (no instant jump to warp speed).
    t += 50; c.updateMirror(t);
    expect(e.x - 100).toBeLessThan(WARP_SPEED * 0.05 * 0.05);
    expect(e.warp).toBe(2);
    expect(c.mirror.travelDeep).toBe(false);

    // Cruise: full warp speed, deep space.
    t = 1000 + 4000; c.updateMirror(t);
    const x0 = e.x;
    t += 50; c.updateMirror(t);
    expect(e.x - x0).toBeCloseTo(WARP_SPEED * 0.05, 3);
    expect(c.mirror.travelDeep).toBe(true);

    // Destination loaded: the arrival pose is in the prediction world.
    c.predWorld = await PhysicsWorld.create();
    c.predWorld.spawnShip('me', 5000, 7000, 'fighter');
    useUIStore.setState({ firstSnapshotApplied: true });

    // Not before the minimum trip time.
    t = 1000 + 10_000; c.updateMirror(t);
    expect(c.mirror.travelJumpX ?? 0).toBe(0);

    // Approach: placed out along the heading and flown in onto the arrival point.
    t = 1000 + 23_000; c.updateMirror(t);
    expect(c.mirror.travelJumpX).not.toBe(0);
    expect(e.x).toBeLessThan(5000);
    expect(c.mirror.travelDeep).toBe(false);
    expect(useUIStore.getState().joinMinimumElapsed).toBe(false);
    t = 1000 + 30_000; c.updateMirror(t);
    expect(e.x).toBeCloseTo(5000, 1);
    expect(e.y).toBeCloseTo(7000, 1);
    expect(useUIStore.getState().joinMinimumElapsed).toBe(true);

    c.endTravel();
    expect(c.mirror.travelling).toBe(false);
    expect(e.warp).toBeUndefined();
  });

  it('the approach brakes hard far out, then glides: slow near the arrival point, ends on it at rest', () => {
    // Find the end and the boundary by scanning.
    let prev = travelApproach(0);
    expect(prev[1]).toBeCloseTo(WARP_SPEED, 0);
    let end = prev;
    for (let tau = 0.01; tau <= 20; tau += 0.01) {
      const cur = travelApproach(tau);
      // Continuous position and speed (no jumps between 10 ms steps).
      expect(cur[0] - prev[0]).toBeLessThanOrEqual(WARP_SPEED * 0.01 + 1e-6);
      expect(Math.abs(cur[1] - prev[1])).toBeLessThan(WARP_SPEED * 0.03);
      prev = cur; end = cur;
      if (cur[1] === 0) break;
    }
    expect(end[1]).toBe(0);
    const total = end[0];
    // Within the last 4 km nothing is passed faster than the glide speed.
    for (let tau = 0; tau <= 20; tau += 0.05) {
      const [d, v] = travelApproach(tau);
      if (total - d <= 4000) expect(v).toBeLessThanOrEqual(2500 + 1e-6);
    }
  });
});
