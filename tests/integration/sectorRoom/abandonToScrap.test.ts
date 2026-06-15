/**
 * Equinox P6.3 (C2 — "scrap replaces wrecks") — abandon → SCRAP through the real
 * SectorRoom abandon-detection poll. Supersedes the old abandonToWreck.test.ts:
 * an abandoned hull no longer becomes a damageable WreckState entity, it
 * shatters into drifting scrap (composite kinds) and leaves the world.
 *
 * COVERS:
 *   1. Active COMPOSITE ship → store.delete → poll cycle → the hull is removed
 *      from state.ships, one scrap piece per component appears, NO wreck is
 *      created, and the owning session gets a ship_abandoned notification.
 *   2. Stored ship (not in the sector) → store.delete → poll cycle → row
 *      deleted, NO scrap, NO wreck (no slot ⇒ nothing in the world to shatter).
 *
 * (The now-dead wreck entity/schema/wire plumbing is removed in the C3 PR; until
 * then nothing creates a WreckState, so state.wrecks is always empty.)
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

describe('SectorRoom integration — abandon → scrap (Equinox P6.3 / C2)', () => {
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

  it('active COMPOSITE ship → store.delete → hull shatters into scrap (no wreck)', async () => {
    const pid = randomUUID();
    // Direct joinOrCreate (NOT connectActive): the abandon flow calls
    // client.leave(1000) on the owning session, which hangs the afterEach
    // room.leave() ack — bypassing connectedRooms skips that cleanup.
    const client = await harness.client.joinOrCreate('test-sector', {
      playerId: pid, shipKind: 'havok', spawnX: 800, spawnY: -300,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    client.send('client_ready', { type: 'client_ready' });
    await harness.advance(800);

    const room = getRoomById(client.roomId);
    const state = room.state as SectorState;
    const internal = room._internals;

    let shipId = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) { shipId = ship.shipInstanceId; break; }
    }
    expect(shipId).not.toBe('');
    expect(state.ships.get(shipId)!.kind).toBe('havok');
    expect(scrapCount(internal)).toBe(0);

    let abandonedMsg: { shipInstanceId: string } | null = null;
    client.onMessage('ship_abandoned', (msg: unknown) => { abandonedMsg = msg as { shipInstanceId: string }; });

    // Trigger abandon (same path as devPlayerShipsAbandonHandler).
    getPlayerShipStore().delete(shipId);

    // Outcome-gate on the hull leaving the world (poll runs every 30 ticks).
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && state.ships.get(shipId) !== undefined) {
      await harness.advance(50);
    }

    // Hull removed, NO wreck, scrap appeared (one per component), session notified.
    expect(state.ships.get(shipId), 'abandoned hull leaves state.ships').toBeUndefined();
    expect(state.wrecks.size, 'no wreck is ever created — scrap replaces wrecks').toBe(0);
    expect(scrapCount(internal)).toBe(shipScrapGroups('havok').length);
    expect(getPlayerShipStore().get(shipId)).toBeNull();
    expect(abandonedMsg).not.toBeNull();
    expect(abandonedMsg!.shipInstanceId).toBe(shipId);
  }, 20_000);

  it('stored ship abandon → row deleted, NO scrap, NO wreck', async () => {
    const pid = randomUUID();
    const store = getPlayerShipStore();
    const seeded = store.create({
      playerId: pid, userId: null, kind: 'havok', sectorKey: 'sol-prime', x: 0, y: 0, health: 80,
    });
    expect(store.get(seeded.shipId)!.isActive).toBe(false);

    // A different player keeps the room alive + the poll running.
    const otherPid = randomUUID();
    await harness.connectAs(otherPid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === otherPid });

    store.delete(seeded.shipId);
    await harness.advance(1000); // > 1 poll cycle

    const room = harness.getServerRoom()!;
    const internal = (room as unknown as SectorRoom)._internals;
    expect((room.state as SectorState).wrecks.size).toBe(0);
    expect(scrapCount(internal)).toBe(0); // no slot ⇒ nothing to shatter
    expect(store.get(seeded.shipId)).toBeNull();
  });
});
