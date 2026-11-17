/**
 * Cargo pods slice 14c: auto-unload is configurable on both ends (owner
 * 2026-11-17). A ship with its switch off keeps its hold beside its own
 * storage; a storage that refuses auto-unload is passed over; with both on
 * the hold banks as before. The open storage window reports both switches.
 * The room runs at 4× game speed so the 2 s dwell takes half a second.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { CargoState } from '../../../src/shared-types/messages/cargoMessages.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { getPlayerShipStore } from '../../../src/server/playerShips/PlayerShipStore.js';

function serverRoom(id: string): SectorRoom {
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

describe('SectorRoom integration: auto-unload on both ends (cargo pods 14c)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], timeScale: 4 });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('ship switch off keeps the hold; storage refusing keeps it; both on banks it', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr: Room = await harness.connectActive(pid, { spawnX: 0, spawnY: 0, initialCargo: { goods: { salvage: 9 }, blueprints: [] } });
    const replies: CargoState[] = [];
    cr.onMessage('cargo_state', (m: CargoState) => replies.push(m));
    const r = serverRoom(cr.roomId);
    const internal = r._internals;
    let shipId = '';
    for (const [, s] of (r.state as SectorState).ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');

    // Ship switch off BEFORE the storage exists, so the dwell never banks early.
    cr.send('set_auto_unload', { type: 'set_auto_unload', side: 'ship', on: false });
    expect(await until(() => getPlayerShipStore().get(shipId)?.autoUnload === false, 3_000), 'the ship switch is saved on the roster').toBe(true);

    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 150, y: 0 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === pid), 5_000)).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === pid)!;
    const entityId = internal.swarmRegistry.get(cap.id)!.entityId;

    await new Promise((res) => setTimeout(res, 1_500)); // 6 s game time: three dwells
    expect(getHoldStore().get(shipId)?.hold.goods.salvage, 'ship switch off: nothing unloads').toBe(9);

    // The storage window shows both switches.
    const n = replies.length;
    cr.send('cargo_query', { type: 'cargo_query', entityId });
    expect(await until(() => replies.length > n, 4_000)).toBe(true);
    const view = replies[replies.length - 1]!;
    expect(view.autoUnload).toBe(false);
    expect(view.acceptAutoUnload).toBe(true);

    // Storage refuses, ship switch on: still nothing unloads.
    cr.send('set_auto_unload', { type: 'set_auto_unload', side: 'storage', on: false, entityId });
    expect(await until(() => cap.acceptAutoUnload === false, 3_000), 'the storage switch is set').toBe(true);
    cr.send('set_auto_unload', { type: 'set_auto_unload', side: 'ship', on: true });
    expect(await until(() => getPlayerShipStore().get(shipId)?.autoUnload !== false, 3_000)).toBe(true);
    await new Promise((res) => setTimeout(res, 1_500));
    expect(getHoldStore().get(shipId)?.hold.goods.salvage, 'storage refusing: nothing unloads').toBe(9);

    // Both on: the hold banks.
    cr.send('set_auto_unload', { type: 'set_auto_unload', side: 'storage', on: true, entityId });
    expect(await until(() => getHoldStore().get(shipId) === undefined, 8_000), 'both on: the hold banks').toBe(true);
    expect(cap.hold?.goods.salvage).toBe(9);
  });

  it("a stranger's switch on my storage is ignored", { timeout: 30_000 }, async () => {
    const owner = randomUUID();
    const crOwner = await harness.connectActive(owner, { spawnX: 0, spawnY: 0 });
    const r = serverRoom(crOwner.roomId);
    const internal = r._internals;
    crOwner.send('place_structure', { type: 'place_structure', kind: 'capital', x: 300, y: 0 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === owner), 5_000)).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === owner)!;
    const entityId = internal.swarmRegistry.get(cap.id)!.entityId;

    const crOther = await harness.connectActive(randomUUID(), { spawnX: -300, spawnY: 0 });
    crOther.send('set_auto_unload', { type: 'set_auto_unload', side: 'storage', on: false, entityId });
    await new Promise((res) => setTimeout(res, 500));
    expect(cap.acceptAutoUnload, 'only the owner sets the storage end').toBeUndefined();
  });
});
