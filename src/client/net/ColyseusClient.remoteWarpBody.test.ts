/**
 * Phase 4 warp travel: another pilot's ship on its warp run (snapshot warp 2)
 * is out of the world, so the local prediction drops its collision body
 * (nothing can bump into it) and brings it back when it drops out (warp 3).
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { ShipRenderState } from '@core/contracts/IRenderer';

interface Internals {
  syncRemoteWarpBodies(snap: unknown): void;
  predWorld: PhysicsWorld | null;
  predRemoteShipIds: Set<string>;
  mirror: { ships: Map<string, ShipRenderState>; localPlayerId: string | null };
}

describe('remote ship on a warp run has no collision body', () => {
  it('drops the body on the run and restores it at the landing pose', async () => {
    const c = new ColyseusGameClient() as unknown as Internals;
    c.predWorld = await PhysicsWorld.create();
    c.mirror.localPlayerId = 'me';
    c.predWorld.spawnShip('other', 0, 0, 'fighter');
    c.predRemoteShipIds.add('other');
    c.mirror.ships.set('other', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter', warp: 2 });

    c.syncRemoteWarpBodies({ states: {} });
    expect(c.predWorld.hasShip('other')).toBe(false);

    // The mirror still holds a stale mid-run pose; the snapshot has the landing.
    const e = c.mirror.ships.get('other')!;
    e.warp = 3; e.x = 40_000; e.y = 0;
    c.syncRemoteWarpBodies({ states: { other: { x: 90_000, y: 50, vx: 150, vy: 0, angle: 0, angvel: 0 } } });
    expect(c.predWorld.hasShip('other')).toBe(true);
    expect(c.predWorld.getShipState('other')!.x).toBeCloseTo(90_000, 0);
    expect(e.x).toBe(90_000); // drawn at the landing at once (the arrival effect too)
  });

  it('a ship that just arrived (warp 3) is snapped to the snapshot pose at once, even when it already has a body', async () => {
    // Joining ships already have a body, posed from a stale room-state pose;
    // drawing the arrival there put the effect beside the ship (user report).
    const c = new ColyseusGameClient() as unknown as Internals & { _remoteShipOffsets: Map<string, unknown> };
    c.predWorld = await PhysicsWorld.create();
    c.mirror.localPlayerId = 'me';
    c.predWorld.spawnShip('joiner', 100, 100, 'fighter');
    c.predRemoteShipIds.add('joiner');
    c.mirror.ships.set('joiner', { x: 100, y: 100, vx: 0, vy: 0, angle: 0, kind: 'fighter', warp: 3 });
    c.syncRemoteWarpBodies({ states: { joiner: { x: 600, y: 250, vx: 0, vy: 0, angle: 0.5, angvel: 0 } } });
    expect(c.predWorld.getShipState('joiner')!.x).toBeCloseTo(600, 3);
    const e = c.mirror.ships.get('joiner')!;
    expect(e.x).toBe(600);
    expect(e.y).toBe(250);
  });
});
