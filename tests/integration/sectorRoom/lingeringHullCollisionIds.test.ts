/**
 * Two-sided lock (#15) for collision ids on a parked hull (RTS Part A S3).
 *
 * The server's physics worker keys a parked hull's body `linger-<sid>`; since
 * S3 the client keys the same hull's prediction body by the bare sid (its key
 * in the one ship list). `collision_resolved` names BODIES, so the server maps
 * them in ONE place (`wireShipBodyId`) and the client must find every named
 * body in its own prediction world. If either side changes its key, this
 * fails: a hull id the client cannot resolve means a ram on an AI-flown ship
 * is silently dropped by `applyCollisionResolved`.
 *
 * Scene: the same as `lingeringHullPush.test.ts` (a reconnect with a new ship
 * leaves the old hull parked at the origin; the new ship rams it). The REAL
 * `ColyseusGameClient` (an observer) is fed the real schema patches and
 * snapshots, so both ships get their client bodies through the production
 * remote-ship path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { CollisionResolvedMessage, SnapshotMessage } from '../../../src/shared-types/messages.js';
import { ColyseusGameClient } from '../../../src/client/net/ColyseusClient.js';
import { PhysicsWorld } from '../../../src/core/physics/World.js';
import { LINGER_BODY_PREFIX } from '../../../src/shared-types/shipBodyIds.js';

const PID = randomUUID();

interface ClientInternals {
  predWorld: PhysicsWorld | null;
  mirror: { localPlayerId: string | null };
  syncMirror(state: unknown): void;
  handleSnapshot(snap: SnapshotMessage): void;
}

describe('collision_resolved names a parked hull by the id the client keys its body by', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a ram on a parked hull: server sends the bare shipInstanceId, the client body exists under it', async () => {
    const client1 = await harness.connectAs(PID, { spawnX: 0, spawnY: 0, shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === PID });
    const state = harness.getServerRoom()!.state as SectorState;
    const [hullId] = [...state.ships.entries()][0]!;
    await harness.disconnectClient(client1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID });

    // A completed join (client_ready): the new ship is ACTIVE, keyed by PID on both sides.
    const client2 = await harness.connectActive(PID, { isNewShip: true, shipKind: 'fighter', spawnX: 0, spawnY: -25 });

    // The real client, as an observer (both of PID's ships are remote to it).
    const obs = new ColyseusGameClient();
    const c = obs as unknown as ClientInternals;
    c.predWorld = await PhysicsWorld.create();
    c.mirror.localPlayerId = 'observer';
    client2.onStateChange((s) => c.syncMirror(s));
    client2.onMessage('snapshot', (snap: SnapshotMessage) => c.handleSnapshot(snap));
    const collisions: CollisionResolvedMessage[] = [];
    client2.onMessage('collision_resolved', (m: CollisionResolvedMessage) => collisions.push(m));
    await harness.advance(300);
    expect(c.predWorld!.hasShip(hullId), 'the client keys the parked hull body by its shipInstanceId').toBe(true);

    for (let i = 0; i < 20; i++) {
      harness.sendThrust(client2);
      await harness.advance(50);
    }

    const onHull = collisions.filter((m) => m.aId === hullId || m.bId === hullId);
    expect(onHull.length, 'the ram reached the client as collision_resolved naming the hull').toBeGreaterThan(0);
    for (const m of collisions) {
      expect(m.aId.startsWith(LINGER_BODY_PREFIX), `server-internal body id leaked: ${m.aId}`).toBe(false);
      expect(m.bId.startsWith(LINGER_BODY_PREFIX), `server-internal body id leaked: ${m.bId}`).toBe(false);
    }
    // Both bodies a hull collision names exist in the client's prediction world.
    const m = onHull[0]!;
    expect(c.predWorld!.hasShip(m.aId), `client has no body "${m.aId}"`).toBe(true);
    expect(c.predWorld!.hasShip(m.bId), `client has no body "${m.bId}"`).toBe(true);
    await harness.disconnectClient(client2);
  }, 25_000);
});
