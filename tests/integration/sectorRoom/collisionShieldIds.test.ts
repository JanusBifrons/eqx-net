/**
 * User report 2026-11-07: "the shield should show on collisions when it's
 * raised, same as on shots hitting the shields". A shot's shield flash comes
 * from its DamageEvent; a collision only sends `collision_resolved`, which
 * named the bodies by SERVER ids (a drone's `swarm-drone-3`, unknown to the
 * client), so nothing could be drawn. The message must say, per side, which
 * client entity it is: -1 for a pilot (its id is the playerId), else the
 * swarm entity id.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

type Msg = { aId: string; bId: string; eA?: number; eB?: number };

describe('SectorRoom integration — collision_resolved names the client entities', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('two pilots: both sides are pilots (-1)', async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
    const p1 = randomUUID(), p2 = randomUUID();
    const cr = await harness.connectActive(p1, { shipKind: 'fighter' });
    await harness.connectActive(p2, { shipKind: 'fighter' });
    const got: Msg[] = [];
    cr.onMessage('collision_resolved', (m: Msg) => got.push(m));
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    room._internals.postToWorker({ type: 'SET_POSITION', entityId: p1, x: 0, y: -50, angle: 0, vx: 0, vy: 600, angvel: 0 });
    room._internals.postToWorker({ type: 'SET_POSITION', entityId: p2, x: 0, y: 50, angle: 0, vx: 0, vy: -600, angvel: 0 });
    const end = Date.now() + 4000;
    while (got.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
    expect(got.length).toBeGreaterThan(0);
    expect(got[0]!.eA).toBe(-1);
    expect(got[0]!.eB).toBe(-1);
  }, 30_000);

  it('a pilot into a drone: the drone side carries its swarm entity id', async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      dronePoses: [{ kind: 'fighter', x: 0, y: 60 }] });
    const p1 = randomUUID();
    const cr = await harness.connectActive(p1, { shipKind: 'fighter', spawnX: 0, spawnY: -400 });
    const got: Msg[] = [];
    cr.onMessage('collision_resolved', (m: Msg) => got.push(m));
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    const reg = (room as unknown as { swarmRegistry: { all(): Iterable<{ id: string; entityId: number; kind: number }> } }).swarmRegistry;
    const drone = [...reg.all()].find((r) => r.kind === 1)!;
    expect(drone).toBeDefined();
    room._internals.postToWorker({ type: 'SET_POSITION', entityId: p1, x: 0, y: -40, angle: 0, vx: 0, vy: 900, angvel: 0 });
    const end = Date.now() + 4000;
    while (!got.some((m) => m.aId === drone.id || m.bId === drone.id) && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
    const m = got.find((x) => x.aId === drone.id || x.bId === drone.id)!;
    expect(m).toBeDefined();
    const droneSide = m.aId === drone.id ? m.eA : m.eB;
    const pilotSide = m.aId === drone.id ? m.eB : m.eA;
    expect(droneSide).toBe(drone.entityId);
    expect(pilotSide).toBe(-1);
  }, 30_000);
});
