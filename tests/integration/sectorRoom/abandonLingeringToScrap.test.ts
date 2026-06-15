/**
 * Equinox P6.3 (C2 — "scrap replaces wrecks") — abandoning a LINGERING hull
 * (displaced / disconnected, isActive=false, still in-world) shatters it into
 * scrap and removes it. Supersedes abandonLingeringToWreck.
 *
 * This is the abandon-POLL trigger for a lingering hull (roster row deleted),
 * distinct from the combat-DEATH trigger locked by lingeringScrapOnDeath.test.ts
 * — both end the same way (scrap + hull removed), keyed by shipInstanceId so the
 * owner's OTHER active hull is never touched.
 *
 * Flow (mirrors the old abandonLingeringToWreck fresh-spawn-displace):
 *   1. PID spawns a COMPOSITE havok (origId).
 *   2. PID disconnects → havok lingers (isActive=false).
 *   3. PID reconnects isNewShip → scout active; havok displaced into lingering.
 *   4. The havok's roster row is deleted → the 30-tick poll shatters it into
 *      scrap, removes it, and leaves the active scout untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { shipScrapGroups } from '../../../src/core/geometry/shipScrapGroups.js';
import { SWARM_KIND_SCRAP } from '../../../src/shared-types/swarmWireFormat.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('SectorRoom integration — abandon lingering hull → scrap (Equinox P6.3 / C2)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  function scrapCount(internal: SectorRoom['_internals']): number {
    return [...internal.swarmRegistry.all()].filter((r) => r.kind === SWARM_KIND_SCRAP).length;
  }

  it('displaced lingering composite hull, when abandoned, shatters into scrap and leaves the active hull untouched', async () => {
    const pid = randomUUID();

    const cr1 = await harness.connectActive(pid, { shipKind: 'havok', spawnX: 640, spawnY: -420 });
    const roomId = cr1.roomId;
    const state = getRoomById(roomId).state as SectorState;

    let origId = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) { origId = ship.shipInstanceId; break; }
    }
    expect(origId).not.toBe('');
    expect(state.ships.get(origId)!.kind).toBe('havok');

    await harness.disconnectClient(cr1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });

    const cr2 = await harness.connectActive(pid, { isNewShip: true, shipKind: 'scout' });
    expect(state.ships.size).toBe(2);
    expect(state.ships.get(origId)!.isActive).toBe(false);

    const internal = getRoomById(cr2.roomId)._internals;
    expect(scrapCount(internal)).toBe(0);

    let activeId = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) { activeId = ship.shipInstanceId; break; }
    }
    expect(activeId).not.toBe('');
    expect(activeId).not.toBe(origId);

    // Abandon the lingering havok (POST /dev/player-ships/:shipId/abandon effect).
    expect(getPlayerShipStore().get(origId)).not.toBeNull();
    getPlayerShipStore().delete(origId);

    // The 30-tick poll shatters it into scrap and removes it.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && state.ships.get(origId) !== undefined) {
      await harness.advance(50);
    }

    expect(state.ships.get(origId), 'abandoned lingering hull leaves state.ships').toBeUndefined();
    expect(scrapCount(internal)).toBe(shipScrapGroups('havok').length);
    expect(getPlayerShipStore().get(origId)).toBeNull();

    // CRITICAL: the player's active scout is completely untouched.
    const activeShip = state.ships.get(activeId);
    expect(activeShip).toBeDefined();
    expect(activeShip!.isActive).toBe(true);
    expect(activeShip!.playerId).toBe(pid);
    expect(getPlayerShipStore().get(activeId)).not.toBeNull();

    await harness.disconnectClient(cr2);
  }, 25_000);
});
