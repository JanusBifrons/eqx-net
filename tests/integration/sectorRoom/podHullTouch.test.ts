/**
 * A loot pod that hits a ship's hull is never destroyed by the bump (pods are
 * indestructible), and the touch does not pick it up: pickup is the loot
 * window or a tractor hold (plan cargo-pods slice 14).
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

describe('SectorRoom integration — a pod that hits the hull survives the bump', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a pod thrown fast into the barge side is never destroyed by the bump, nor taken in by the touch', { timeout: 30_000 }, async () => {
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
    const loot = int().loot;
    const podId = loot.drop({ goods: { minerals: 40 }, blueprints: [] }, pose.x + nx * (d + 150), pose.y + ny * (d + 150), -nx * speed, -ny * speed);
    expect(podId).not.toBeNull();
    for (let i = 0; i < 40; i++) await harness.advance(50);
    expect(loot.isPod(podId!), 'the bump never destroys the pod').toBe(true);
    expect(getHoldStore().get(ship.shipInstanceId)?.hold.goods.minerals ?? 0, 'a touch picks nothing up').toBe(0);
  });
});
