/**
 * Hostile-review A1 (plan peppy-jumping-pinwheel P1a-1) — a lingering hull
 * killed in combat must DELETE its roster row (D9: destroyed ⇒ wiped), exactly
 * like an active hull.
 *
 * Bug: `createLingeringHullEntity`'s death policy deleted the ship from
 * `shipsMap` BEFORE emitting `SHIP_DESTROYED`, so the handler's
 * `state.ships.get(targetId)` lookup missed and `deleteRosterRow` never ran.
 * The dead hull's row survived (a "dead" ship came back on the roster). Once
 * per-ship CARGO lives on that row, this is an infinite duplication: the hold
 * spills as loot AND stays on the row.
 *
 * Flow mirrors lingeringScrapOnDeath: spawn → disconnect (linger) → reconnect
 * with a fresh ship (the old one is displaced into a lingering hull) → kill the
 * lingering hull by shipInstanceId → its roster row must be gone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('SectorRoom integration — lingering-hull death deletes its roster row (A1)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('killing a lingering hull removes it from the roster', async () => {
    const pid = randomUUID();
    const cr1 = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 640, spawnY: -420 });
    const state = getRoomById(cr1.roomId).state as SectorState;

    let origId = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) { origId = ship.shipInstanceId; break; }
    }
    expect(origId).not.toBe('');

    await harness.disconnectClient(cr1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    const cr2 = await harness.connectActive(pid, { isNewShip: true, shipKind: 'scout' });
    expect(state.ships.get(origId)!.isActive).toBe(false);
    expect(getPlayerShipStore().get(origId), 'precondition: the lingering hull has a roster row').not.toBeNull();

    const internal = getRoomById(cr2.roomId)._internals;
    for (let i = 0; i < 5 && state.ships.get(origId) !== undefined; i++) {
      internal.applyDamage(origId, pid, 9999);
    }
    expect(state.ships.get(origId)).toBeUndefined(); // hull removed from the world

    expect(
      getPlayerShipStore().get(origId),
      'a destroyed lingering hull must be wiped from the roster (D9) — else its cargo duplicates',
    ).toBeNull();

    await harness.disconnectClient(cr2);
  }, 25_000);
});
