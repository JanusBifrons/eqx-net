/**
 * Phase 4 travel state: a sector-to-sector trip. The local ship accelerates
 * out along its heading, cruises at warp speed while the destination loads,
 * then (after the minimum trip time, once the destination is loaded) is placed
 * on approach and decelerates exactly onto its arrival point. The approach
 * jump is recorded for the sky; the end of the approach opens the
 * minimum-display gate (the ship then arrives for everyone).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { travelApproach, noteSwarmPacket, type TravelTrip } from './mirror/travelPass.js';
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

describe('a teleport to another sector (gate or paired teleporter)', () => {
  beforeEach(() => { useUIStore.setState({ firstSnapshotApplied: false, joinMinimumElapsed: false, travelling: true }); });

  it('holds the ship still where it sealed, then puts it straight on the far pad: no fly-out, no warp run, no 25 s trip', async () => {
    // Film 2026-11-26: riding the Sol Prime gate flew the ship off at warp
    // speed for a whole sector trip, instead of swapping it like a teleporter.
    const c = new ColyseusGameClient() as unknown as Internals & { beginTravel(mode?: 'trip' | 'hold'): void; travelOutRemainingMs(): number };
    let t = 1000;
    c.clock = { now: () => t };
    c.mirror.localPlayerId = 'me';
    c.mirror.ships.set('me', { x: 100, y: 50, vx: 0, vy: 0, angle: -Math.PI / 2 });
    // The source room is still loaded as the gate seals: its body and its
    // first snapshot are there (film take 11: the hold landed on the spot,
    // so the ship sat in empty Vega Reach sky at its Sol Prime position).
    c.predWorld = await PhysicsWorld.create();
    c.predWorld.spawnShip('me', 100, 50, 'fighter');
    useUIStore.setState({ firstSnapshotApplied: true });
    c.beginTravel('hold');
    expect(c.travelOutRemainingMs()).toBe(0);
    const e = c.mirror.ships.get('me')!;

    t += 2000; c.updateMirror(t);
    expect(e.x).toBe(100);
    expect(e.y).toBe(50);
    expect(e.warp).toBeUndefined();
    expect(c.mirror.travelDeep).toBe(false);
    expect(useUIStore.getState().joinMinimumElapsed).toBe(false);

    // The room swap (transit_ready) re-arms join readiness; the far room's
    // body and first snapshot follow.
    useUIStore.getState().rearmJoinReadiness();
    c.predWorld.despawnShip('me');
    c.predWorld.spawnShip('me', 5000, 7000, 'fighter');
    t += 50; c.updateMirror(t);
    expect(e.x).toBe(100);
    useUIStore.setState({ firstSnapshotApplied: true });
    noteSwarmPacket((c as unknown as { _travel: TravelTrip | null })._travel, true);
    t += 50; c.updateMirror(t);
    expect(e.x).toBeCloseTo(5000, 1);
    expect(e.y).toBeCloseTo(7000, 1);
    expect(c.mirror.travelJumpX).toBeCloseTo(4900, 1);
    expect(e.warp).toBeUndefined();
    expect(useUIStore.getState().joinMinimumElapsed).toBe(true);
  });

  it('keeps the old sector on screen until the far sector is all there, then swaps in one frame (the gate never blinks out)', async () => {
    // Take 14 2026-11-26: for two frames at the swap no gate was drawn. The
    // old sector was wiped as the room swap began, with the ship still in the
    // gate, and the far gate (a sleeping structure) only rides a FULL swarm
    // packet, which can come after the far room's first snapshot.
    type Hold = Internals & { beginTravel(mode?: 'trip' | 'hold'): void; holdingPicture(): boolean; _travel: TravelTrip | null };
    const c = new ColyseusGameClient() as unknown as Hold;
    let t = 1000;
    c.clock = { now: () => t };
    c.mirror.localPlayerId = 'me';
    c.mirror.ships.set('me', { x: 100, y: 50, vx: 0, vy: 0, angle: 0 });
    c.predWorld = await PhysicsWorld.create();
    c.predWorld.spawnShip('me', 100, 50, 'fighter');
    useUIStore.setState({ firstSnapshotApplied: true });
    c.beginTravel('hold');
    const e = c.mirror.ships.get('me')!;
    // Sealing in the source room: the picture is live.
    t += 50; c.updateMirror(t);
    expect(c.holdingPicture()).toBe(false);

    // The room swap starts: the old sector is wiped from the mirror, so the
    // picture holds what is on screen (gate and all).
    useUIStore.getState().rearmJoinReadiness();
    expect(c.holdingPicture()).toBe(true);
    c.predWorld.despawnShip('me');
    c.predWorld.spawnShip('me', 5000, 7000, 'fighter');
    // A delta packet from the far room is not the whole scene.
    noteSwarmPacket(c._travel, false);
    useUIStore.setState({ firstSnapshotApplied: true });
    t += 50; c.updateMirror(t);
    expect(e.x).toBe(100);
    expect(c.holdingPicture()).toBe(true);

    // The far room's full packet (every structure in view, the far gate too):
    // the ship lands and the picture goes live in the same frame.
    noteSwarmPacket(c._travel, true);
    t += 16; c.updateMirror(t);
    expect(e.x).toBeCloseTo(5000, 1);
    expect(c.holdingPicture()).toBe(false);
  });

  it('a far sector that sends no swarm at all still lands (the hold never sticks)', async () => {
    type Hold = Internals & { beginTravel(mode?: 'trip' | 'hold'): void; holdingPicture(): boolean };
    const c = new ColyseusGameClient() as unknown as Hold;
    let t = 1000;
    c.clock = { now: () => t };
    c.mirror.localPlayerId = 'me';
    c.mirror.ships.set('me', { x: 100, y: 50, vx: 0, vy: 0, angle: 0 });
    c.predWorld = await PhysicsWorld.create();
    c.beginTravel('hold');
    const e = c.mirror.ships.get('me')!;
    useUIStore.getState().rearmJoinReadiness();
    c.predWorld.spawnShip('me', 5000, 7000, 'fighter');
    useUIStore.setState({ firstSnapshotApplied: true });
    t += 50; c.updateMirror(t);
    expect(e.x).toBe(100);
    t += 2000; c.updateMirror(t);
    expect(e.x).toBeCloseTo(5000, 1);
    expect(c.holdingPicture()).toBe(false);
  });
});
