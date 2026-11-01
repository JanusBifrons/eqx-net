/**
 * Living World P1a-2 (plan peppy-jumping-pinwheel) — base storage end to end:
 *
 *  1. AUTO-DEPOSIT: a ship carrying cargo that holds position near its OWN
 *     Capital for 2 s banks everything (minerals → the construction bank,
 *     goods → the Capital's hold); the ship keeps nothing.
 *  2. REFINE: `refine_salvage` turns stored salvage into Capital minerals.
 *  3. A razed storage structure SPILLS its whole payload as a loot pod and its
 *     holds row is gone (no orphaned value, no duplication).
 *
 * Production path: real `place_structure` + `refine_salvage` messages. The
 * 2 s dwell is the real game rule (≤ 4 s wall-clock; no budget bump needed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getHoldStore, getWallet } from '../../../src/server/db/PersistenceWorker.js';

function room(id: string): SectorRoom {
  return matchMaker.getLocalRoomById(id) as unknown as SectorRoom;
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe('SectorRoom integration — base storage (P1a-2)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    // asteroidConfig: [] — a random rock under the Capital would reject placement.
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('auto-deposit → refine → raze spills the bank', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      spawnX: 0, spawnY: 0,
      initialCargo: { goods: { salvage: 9, minerals: 40 }, blueprints: [] },
    });
    const r = room(cr.roomId);
    const internal = r._internals;
    const state = r.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    expect(getHoldStore().get(shipId)?.hold.goods.salvage).toBe(9);

    // A Capital 150 u away — pre-built, owned by the player.
    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 150, y: 0 });
    const placed = await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === pid), 5_000);
    expect(placed).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === pid)!;
    expect(cap.uid, 'a placed structure gets a stable uid').toBeDefined();
    const bankBefore = cap.minerals;

    // 1) Hold position → after the 2 s dwell the whole hold is banked.
    harness.sendThrust(cr);
    const banked = await until(() => getHoldStore().get(shipId) === undefined, 10_000);
    expect(banked, 'holding position by your own Capital must deposit the hold').toBe(true);
    expect(cap.minerals).toBe(bankBefore + 40);
    expect(cap.hold?.goods.salvage).toBe(9);
    // The Capital's payload is persisted under its stable uid.
    expect(getHoldStore().get(cap.uid!)?.hold.goods.salvage).toBe(9);

    // 2) Refine 5 salvage → +50 minerals.
    const entityId = internal.swarmRegistry.get(cap.id)!.entityId;
    cr.send('refine_salvage', { type: 'refine_salvage', entityId, qty: 5 });
    const refined = await until(() => (cap.hold?.goods.salvage ?? 0) === 4, 5_000);
    expect(refined).toBe(true);
    expect(cap.minerals).toBe(bankBefore + 40 + 50);

    // 3) Raze it → its whole payload spills as a pod; the holds row is gone.
    const podsBefore = internal.loot.podCount();
    const uid = cap.uid!;
    for (let i = 0; i < 20 && internal.structureRegistry.get(cap.id); i++) {
      internal.applyDamage(cap.id, 'raider', 99_999);
    }
    expect(internal.structureRegistry.get(cap.id)).toBeUndefined();
    expect(getHoldStore().get(uid)).toBeUndefined();
    expect(internal.loot.podCount()).toBe(podsBefore + 1);
    let spilledSalvage = 0;
    for (const id of internal.loot.podIds()) spilledSalvage += getHoldStore().get(id)?.hold.goods.salvage ?? 0;
    expect(spilledSalvage).toBe(4);
  });

  it('credit sinks: instant repair at your storage is paid from the WALLET; short balance is refused', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      spawnX: 0, spawnY: 0, initialHull: 50,
      initialWallet: 1000,
    });
    const r = room(cr.roomId);
    const internal = r._internals;
    const state = r.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    const ship = state.ships.get(shipId)!;

    // Repair with NO base nearby → refused (nothing changes).
    cr.send('repair_ship', { type: 'repair_ship' });
    await new Promise((res) => setTimeout(res, 300));
    expect(ship.health).toBe(50);

    expect(getWallet().balance(pid)).toBe(1000);

    // Next to your own Capital the repair is paid straight from the wallet.
    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 150, y: 0 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === pid), 5_000)).toBe(true);

    const missing = ship.maxHealth - ship.health;
    cr.send('repair_ship', { type: 'repair_ship' });
    expect(await until(() => ship.health === ship.maxHealth, 5_000), 'repair at your storage restores full hull').toBe(true);
    expect(getWallet().balance(pid)).toBe(1000 - Math.ceil(missing * 0.5));

    // A short wallet is refused: break the hull again with an empty wallet.
    getWallet().debit(pid, getWallet().balance(pid), 'test_drain');
    ship.health = 50;
    cr.send('repair_ship', { type: 'repair_ship' });
    await new Promise((res) => setTimeout(res, 300));
    expect(ship.health).toBe(50);
  });
});
