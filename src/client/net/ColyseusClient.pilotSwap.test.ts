/**
 * Phase 4 WS-A2 — client-side SAME-SECTOR pilot-swap state machine.
 *
 * `pilotInSectorShip(shipId)` sends `pilot_ship` over the live room, despawns the
 * local predWorld body (so the fresh `welcome` re-anchors self-prediction at the
 * new pose — one ownership site, like `resetPredictionState`), and stashes the
 * target shipId. The generic `welcome` handler matches that shipId, leaves
 * spectator (`pilotMode='pilot'`), and arms the camera glide; the RAF loop reads
 * `consumePendingCameraGlide()` (one-shot) to fire the smooth lerp once the new
 * pose is mirrored.
 *
 * These locks exercise the public surface (no live room needed) + reach in for
 * the welcome-driven flags via a narrow structural cast (the same pattern as
 * `ColyseusClient.resetPredictionState.test.ts`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { useUIStore } from '../state/store.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import type { ShipRenderState } from '../../core/contracts/IRenderer.js';

type Internals = {
  room: { send: (t: string, p: unknown) => void } | null;
  mirror: {
    localPlayerId: string | null;
    ships: Map<string, { x: number; y: number; angle: number; vx: number; vy: number }>;
  };
  _pendingPilotSwapShipId: string | null;
  _pilotSwapGlidePending: boolean;
};

function asInternals(c: ColyseusGameClient): Internals {
  return c as unknown as Internals;
}

describe('ColyseusGameClient — WS-A2 pilot swap', () => {
  beforeEach(() => {
    useUIStore.setState({ pilotMode: 'pilot' });
  });

  it('pilotInSectorShip is a no-op (false) with no live room', () => {
    const client = new ColyseusGameClient();
    expect(client.pilotInSectorShip('ship-1')).toBe(false);
  });

  it('pilotInSectorShip sends pilot_ship + records the pending swap id', () => {
    const client = new ColyseusGameClient();
    const internals = asInternals(client);
    const sent: Array<{ t: string; p: unknown }> = [];
    internals.room = { send: (t, p) => sent.push({ t, p }) };

    const ok = client.pilotInSectorShip('ship-target');
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.t).toBe('pilot_ship');
    expect(sent[0]!.p).toEqual({ type: 'pilot_ship', shipId: 'ship-target' });
    expect(internals._pendingPilotSwapShipId).toBe('ship-target');
  });

  it('consumePendingCameraGlide returns the new ship pose ONCE after a swap lands, then null', () => {
    const client = new ColyseusGameClient();
    const internals = asInternals(client);
    // Simulate the welcome-driven arm: glide pending + the new ship is mirrored.
    internals._pilotSwapGlidePending = true;
    internals.mirror.localPlayerId = 'p1';
    internals.mirror.ships.set('p1', { x: 1234, y: -56, angle: 0, vx: 0, vy: 0 });

    const first = client.consumePendingCameraGlide();
    expect(first).toEqual({ x: 1234, y: -56 });
    // One-shot: the flag is cleared, so a second read is null.
    expect(client.consumePendingCameraGlide()).toBeNull();
  });

  it('consumePendingCameraGlide waits (null) until the new pose is mirrored', () => {
    const client = new ColyseusGameClient();
    const internals = asInternals(client);
    internals._pilotSwapGlidePending = true;
    internals.mirror.localPlayerId = 'p1';
    // No mirror entry yet → wait (flag stays armed so a later frame fires it).
    expect(client.consumePendingCameraGlide()).toBeNull();
    expect(internals._pilotSwapGlidePending).toBe(true);
    internals.mirror.ships.set('p1', { x: 5, y: 6, angle: 0, vx: 0, vy: 0 });
    expect(client.consumePendingCameraGlide()).toEqual({ x: 5, y: 6 });
  });

  it('returns null with no pending swap', () => {
    const client = new ColyseusGameClient();
    expect(client.consumePendingCameraGlide()).toBeNull();
  });
});

/**
 * RTS Part A S3 — take controls of a parked, AI-flown hull. The hull is an
 * ordinary remote ship in the ONE ship list (key = its shipInstanceId, body
 * keyed the same). The welcome re-keys it to our playerId: the hull key goes
 * through the ONE drop path (mirror entry + remote body) BEFORE
 * `tryInitPredWorld` spawns the local body, so no two bodies ever overlap and
 * exactly one mirror entry stands for the hull. (These are the two calls the
 * welcome handler makes, in its order.)
 */
describe('ColyseusGameClient — take-controls re-key (RTS Part A S3)', () => {
  type ReKeyInternals = {
    predWorld: PhysicsWorld | null;
    mirror: { localPlayerId: string | null; ships: Map<string, ShipRenderState> };
    handleSnapshot(snap: SnapshotMessage): void;
    rekeyOwnShipFromHull(playerId: string, welcomeShipInstanceId: string): void;
    tryInitPredWorld(playerId: string): void;
  };

  it('after welcome the hull body is gone, the local body stands at the hull pose, one mirror entry', async () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    const client = new ColyseusGameClient();
    const c = client as unknown as ReKeyInternals;
    c.predWorld = await PhysicsWorld.create();
    c.mirror.localPlayerId = 'p1';
    // The parked hull: identity (schema) + a snapshot spawns its remote body.
    c.mirror.ships.set('HULL', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter', isActive: false, ownerPlayerId: 'p1' });
    c.handleSnapshot({
      type: 'snapshot', serverTick: 10, ackedTick: 0,
      states: { HULL: { x: 400, y: -120, vx: 0, vy: 0, angle: 0.3, angvel: 0, playerId: 'p1', isActive: false } },
    } as unknown as SnapshotMessage);
    expect(c.predWorld!.hasShip('HULL'), 'the parked hull has its remote body').toBe(true);

    // Welcome for the swap: re-key, then bootstrap the local body.
    c.rekeyOwnShipFromHull('p1', 'HULL');
    c.tryInitPredWorld('p1');

    expect(c.predWorld!.hasShip('HULL'), 'the hull body was dropped before the local body spawned').toBe(false);
    expect(c.predWorld!.hasShip('p1')).toBe(true);
    expect(c.mirror.ships.has('HULL')).toBe(false);
    let entries = 0;
    for (const k of c.mirror.ships.keys()) if (k === 'p1' || k === 'HULL') entries++;
    expect(entries, 'exactly one mirror entry stands for the hull').toBe(1);
    const local = c.predWorld!.getShipState('p1')!;
    expect(local.x).toBeCloseTo(400, 1);
    expect(local.y).toBeCloseTo(-120, 1);
  });

  it('never re-keys a same-player OLD hull when the welcome names another ship', async () => {
    const client = new ColyseusGameClient();
    const c = client as unknown as ReKeyInternals;
    c.predWorld = await PhysicsWorld.create();
    c.mirror.localPlayerId = 'p1';
    c.mirror.ships.set('OLD', { x: 9, y: 9, vx: 0, vy: 0, angle: 0, kind: 'fighter', isActive: false, ownerPlayerId: 'p1' });
    c.rekeyOwnShipFromHull('p1', 'NEW');
    expect(c.mirror.ships.has('OLD'), 'the displaced hull stays parked').toBe(true);
    expect(c.mirror.ships.has('p1')).toBe(false);
  });
});
