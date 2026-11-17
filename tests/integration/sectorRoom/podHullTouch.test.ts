/**
 * A loot pod that hits a ship's hull goes into its hold; the bump never
 * destroys it (owner #758: a pod goes in when it touches the hull).
 *
 * Seen on film (barge-mining, 2026-11-17): the tractors pulled the last ore
 * pods into the barge's side, they vanished, and the hold did not change. The
 * pod's ram damage (the barge's mass against a 30 hp pod) evicted it as a
 * combat death in the physics contact batch, before the ~10 Hz loot collect
 * pass saw it touching the hull, so its ore was lost (`onPodDestroyed`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { shipWithinHullReach } from '../../../src/core/combat/shipHitShape.js';
import { LOOT_TOUCH_REACH } from '../../../src/server/cargo/LootSubsystem.js';

describe('SectorRoom integration — a pod that hits the hull goes into the hold', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a pod thrown fast into the barge side is taken in, never destroyed by the bump', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [] });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, { shipKind: 'barge', spawnX: 0, spawnY: 0 })) as ClientRoom<SectorState>;
    for (const t of ['damage', 'swarm', 'loot_collected', 'collision_resolved', 'destroy']) cr.onMessage(t, () => {});
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;
    const ship = [...room.state.ships.values()].find((s) => s.playerId === pid)!;
    await harness.advance(200);
    const pose = int().playerPose(pid)!;
    // Just outside the barge's touch reach (along its local +y), flying straight at it.
    const nx = -Math.sin(pose.angle), ny = Math.cos(pose.angle);
    let d = 0;
    while (shipWithinHullReach('barge', false, pose.x + nx * d, pose.y + ny * d, pose.x, pose.y, pose.angle, LOOT_TOUCH_REACH * 4)) d += 10;
    const speed = 3000; // a tractored pod's arrival: its ram damage is far over a pod's hull
    const destroyed: string[] = [];
    const loot = int().loot;
    const onDestroyed = loot.onPodDestroyed.bind(loot);
    loot.onPodDestroyed = (id: string): void => { destroyed.push(id); onDestroyed(id); };
    const podId = loot.drop({ goods: { minerals: 40 }, blueprints: [] }, pose.x + nx * (d + 150), pose.y + ny * (d + 150), -nx * speed, -ny * speed);
    expect(podId).not.toBeNull();
    for (let i = 0; i < 40 && loot.isPod(podId!); i++) await harness.advance(50);
    expect(destroyed, 'the bump never destroys the pod').toEqual([]);
    expect(getHoldStore().get(ship.shipInstanceId)?.hold.goods.minerals ?? 0, 'the pod is in the hold').toBe(40);
  });
});
