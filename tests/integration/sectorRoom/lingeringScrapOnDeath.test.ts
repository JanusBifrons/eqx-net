/**
 * Universal scrap-on-death (Equinox Phase 6 / P6.3) — integration lock for
 * "lingering ships don't explode into scrap; only active ships do."
 *
 * An ACTIVE composite hull breaking into scrap is locked by scrapOnDeath.test.ts
 * (drone) + the SHIP_DESTROYED handler (player). THIS test drives the LINGERING
 * path: a displaced, isActive=false composite hull, when destroyed in combat,
 * must spawn the same scrap pieces. Pre-fix it spawned NONE — the lingering-hull
 * death policy (createLingeringHullEntity) tore down its slot + lingeringPoseCache
 * before emitting SHIP_DESTROYED, and the active-hull scrap block guards on
 * `getActiveShip(targetId) !== undefined` (undefined for a lingering hull), so the
 * scrap path was never reached.
 *
 * Flow (mirrors abandonLingeringToWreck's fresh-spawn-displace, which is the
 * proven way to get a damageable lingering hull with a populated
 * lingeringPoseCache):
 *   1. PID spawns a COMPOSITE havok (origId).
 *   2. PID disconnects → havok lingers (isActive=false).
 *   3. PID reconnects isNewShip → scout active; havok displaced into
 *      lingeringSlots / lingeringPoseCache (still in state.ships, isActive=false).
 *   4. The lingering havok is destroyed (applyDamage by shipInstanceId) → it
 *      must break into one scrap piece per component, exactly like an active hull.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { shipScrapGroups } from '../../../src/core/geometry/shipScrapGroups.js';
import { SCRAP_HP } from '../../../src/core/swarm/scrapConstants.js';
import { SWARM_KIND_SCRAP } from '../../../src/shared-types/swarmWireFormat.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('SectorRoom integration — lingering-hull scrap-on-death (Equinox P6.3)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  function scrapRecs(internal: SectorRoom['_internals']) {
    return [...internal.swarmRegistry.all()].filter((r) => r.kind === SWARM_KIND_SCRAP);
  }

  it('a destroyed COMPOSITE lingering hull breaks into one scrap piece per component', async () => {
    const pid = randomUUID();

    // 1) Spawn a composite havok and complete the join handshake.
    const cr1 = await harness.connectActive(pid, { shipKind: 'havok', spawnX: 640, spawnY: -420 });
    const roomId = cr1.roomId;
    const state = getRoomById(roomId).state as SectorState;

    let origId = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) { origId = ship.shipInstanceId; break; }
    }
    expect(origId).not.toBe('');
    expect(state.ships.get(origId)!.kind).toBe('havok');

    // 2) Disconnect → the havok lingers.
    await harness.disconnectClient(cr1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });

    // 3) Reconnect isNewShip → fresh scout active; the havok is displaced into
    //    lingeringSlots / lingeringPoseCache (isActive=false, still in-world).
    const cr2 = await harness.connectActive(pid, { isNewShip: true, shipKind: 'scout' });
    expect(state.ships.size).toBe(2);
    expect(state.ships.get(origId)!.isActive).toBe(false);

    const internal = getRoomById(cr2.roomId)._internals;
    const expectedPieces = shipScrapGroups('havok').length;
    expect(expectedPieces).toBe(7);
    expect(scrapRecs(internal)).toHaveLength(0);

    // 4) Destroy the lingering havok (resolved by shipInstanceId → the lingering
    //    leaf). Hit repeatedly — the no-spillover shield model fully absorbs the
    //    shield-dropping hit, so the first hit drops the (regenerated) shield and
    //    a later hit lands on hull. Pre-fix: NO scrap. Post-fix: one damageable
    //    piece per component.
    for (let i = 0; i < 5 && state.ships.get(origId) !== undefined; i++) {
      internal.applyDamage(origId, pid, 9999);
    }

    expect(state.ships.get(origId)).toBeUndefined(); // hull removed
    const scrap = scrapRecs(internal);
    expect(scrap, 'a destroyed lingering composite hull must shatter into scrap').toHaveLength(expectedPieces);
    for (const s of scrap) {
      expect(s.shipKind).toBe('havok');
      expect(internal.swarmHealth.get(s.id)).toBe(SCRAP_HP);
    }

    // The active scout is untouched (the lingering death never tears down the
    // player's OTHER hull).
    let activeId = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) { activeId = ship.shipInstanceId; break; }
    }
    expect(activeId).not.toBe('');
    expect(state.ships.get(activeId)!.kind).toBe('scout');

    await harness.disconnectClient(cr2);
  }, 25_000);
});
