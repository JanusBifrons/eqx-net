/**
 * Correctness lock — abandoning a LINGERING hull (still visible in-world,
 * isActive=false) must convert it to a WRECK, not silently linger out its
 * TTL and vanish.
 *
 * Intended behaviour (player spec): "an abandoned ship becomes a wreck if
 * it's still in the game world, otherwise it just vanishes." A lingering
 * hull IS still in the game world (a remote observer renders it), so
 * abandoning it must leave a wreck — symmetric with abandoning an ACTIVE
 * hull (covered by abandonToWreck.test.ts).
 *
 * Pre-fix behaviour (RED): `findAbandonedPlayers` skipped `!ship.isActive`,
 * and `convertShipToWreck(playerId)` is playerId-keyed (reads
 * getActiveShip(playerId)/playerToSlot.get(playerId)) — so an abandoned
 * lingering hull produced NO wreck. The poll never fired for it; it lingered
 * until the 15-min ownerless-evict timer then vanished via markStored.
 *
 * The flow this drives (mirrors lingering.test.ts's fresh-spawn-displace):
 *   1. PID spawns a fighter (origId).
 *   2. PID disconnects → fighter lingers (isActive=false).
 *   3. PID reconnects with isNewShip → scout becomes active; the fighter
 *      is displaced into `lingeringSlots` (still in state.ships, still
 *      visible). state.ships.size === 2.
 *   4. The fighter's roster row is deleted (the abandon endpoint's effect).
 *   5. The 30-tick abandon poll must convert the displaced fighter to a
 *      wreck WITHOUT disturbing PID's active scout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration — abandon lingering hull → wreck', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('displaced lingering hull, when abandoned, converts to a wreck and leaves the active hull untouched', async () => {
    const pid = randomUUID();
    const SPAWN_X = 640;
    const SPAWN_Y = -420;

    // 1) Spawn the original fighter and complete the join handshake so it
    //    is a live, active hull.
    const client1 = await harness.connectActive(pid, {
      shipKind: 'fighter',
      spawnX: SPAWN_X,
      spawnY: SPAWN_Y,
    });

    const state = harness.getServerRoom()!.state as SectorState;
    let origId = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) {
        origId = ship.shipInstanceId;
        break;
      }
    }
    expect(origId).not.toBe('');
    expect(state.ships.get(origId)!.kind).toBe('fighter');

    // 2) Disconnect → the fighter lingers (isActive=false).
    await harness.disconnectClient(client1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    expect(state.ships.get(origId)).toBeDefined();
    expect(state.ships.get(origId)!.isActive).toBe(false);

    // 3) Reconnect with isNewShip → fresh scout becomes active; the
    //    fighter is displaced into lingeringSlots (still in state.ships).
    const client2 = await harness.connectActive(pid, { isNewShip: true, shipKind: 'scout' });
    expect(state.ships.size).toBe(2);

    // Resolve the new active hull (the scout) so we can assert it survives.
    let activeId = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) {
        activeId = ship.shipInstanceId;
        break;
      }
    }
    expect(activeId).not.toBe('');
    expect(activeId).not.toBe(origId);
    expect(state.ships.get(activeId)!.kind).toBe('scout');

    // 4) Abandon the lingering fighter (same effect as
    //    POST /dev/player-ships/:shipId/abandon → store.delete).
    expect(getPlayerShipStore().get(origId)).not.toBeNull();
    getPlayerShipStore().delete(origId);

    // 5) The abandon poll runs every 30 ticks (~500 ms). Allow ~3 cycles.
    await harness.advance(1500);

    // The displaced fighter is now a wreck (RED before the fix — the poll
    // skipped inactive hulls so no wreck appeared).
    const wreck = state.wrecks.get(origId);
    expect(wreck).toBeDefined();
    expect(wreck!.shipInstanceId).toBe(origId);
    expect(wreck!.kind).toBe('fighter');
    expect(wreck!.health).toBeGreaterThan(0);
    expect(wreck!.health).toBeLessThanOrEqual(wreck!.maxHealth);

    // The fighter's ship entry is gone (it became the wreck).
    expect(state.ships.get(origId)).toBeUndefined();

    // The roster row was the delete source, so the store no longer has it.
    expect(getPlayerShipStore().get(origId)).toBeNull();

    // CRITICAL: the player's active scout is completely untouched — the
    // lingering→wreck path must NEVER tear down playerId-keyed state for
    // a player who is piloting a different hull.
    const activeShip = state.ships.get(activeId);
    expect(activeShip).toBeDefined();
    expect(activeShip!.isActive).toBe(true);
    expect(activeShip!.playerId).toBe(pid);
    expect(getPlayerShipStore().get(activeId)).not.toBeNull();

    await harness.disconnectClient(client2);
  });
});
