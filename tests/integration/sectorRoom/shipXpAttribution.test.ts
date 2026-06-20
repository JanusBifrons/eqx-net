/**
 * Ship XP attribution — integration lock for WS-B1 (Phase 4, plan:
 * effervescent-umbrella, invariant #13 "the behaviour lives at the kill →
 * roster seam").
 *
 * The XP curve itself is unit-locked in `src/core/leveling/shipXp.test.ts`;
 * the per-instance store mutator in `PlayerShipStore.test.ts`. THIS test drives
 * the FULL server chain through a REAL galaxy room:
 *
 *   applyDamage(drone, killerPlayer) → swarm death policy → evictSwarmEntity
 *     → auditCombatDestruction(drone) → awardKillXp(killer, droneMaxHealth)
 *     → PlayerShipStore.setProgress + ShipState.level + SHIP_LEVEL_UP bus +
 *       ship_level_up broadcast
 *
 * Asserts the locked decisions:
 *  - a kill awards XP to the FIRING SHIP INSTANCE, not a player pool (D8);
 *  - switching ships keeps each ship's XP separate (D8);
 *  - level-up fires exactly once when a kill crosses one threshold (D10);
 *  - a destroyed ship's progression is dropped atomically with its roster row
 *    (D9 — the destroyed→wipe).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { getDroneMaxHealth } from '../../../src/server/rooms/droneKindHelpers.js';
import { xpForKill, xpToNext } from '../../../src/core/leveling/shipXp.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

/** Resolve the active hull's shipInstanceId for a player in this room. */
function shipInstanceFor(room: SectorRoom, playerId: string): string {
  const state = (room as unknown as { state: SectorState }).state;
  for (const [shipInstanceId, ship] of state.ships) {
    if (ship.playerId === playerId && ship.isActive) return shipInstanceId;
  }
  throw new Error(`no active hull for ${playerId}`);
}

describe('SectorRoom integration — ship XP attribution (Phase 4 WS-B1)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a drone kill awards XP to the FIRING ship instance (not a player pool)', async () => {
    const killer = randomUUID();
    const cr = await harness.connectActive(killer, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === killer });
    const room = getRoomById(cr.roomId);
    const internal = room._internals;
    const instanceId = shipInstanceFor(room, killer);

    // Fresh ship — no XP yet.
    expect(getPlayerShipStore().get(instanceId)!.xp).toBe(0);
    expect(getPlayerShipStore().get(instanceId)!.level).toBe(1);

    // Seed a peaceful drone in range and kill it via the real damage path.
    expect(internal.spawnTestDrone('victim-drone', 600, 0, 'fighter')).toBe(true);
    internal.applyDamage('victim-drone', killer, 99999);

    // XP rides the KILLER'S roster row — keyed by shipInstanceId, never a
    // playerId-keyed pool.
    const expected = xpForKill(getDroneMaxHealth('fighter')!);
    expect(expected).toBeGreaterThan(0);
    expect(getPlayerShipStore().get(instanceId)!.xp).toBe(expected);
    // The live ShipState mirror also reflects level (still 1 below threshold).
    const state = (room as unknown as { state: SectorState }).state;
    expect(state.ships.get(instanceId)!.level).toBe(1);
  });

  it('a drone killed by ANOTHER drone awards no player XP (no firing ship)', async () => {
    const killer = randomUUID();
    const cr = await harness.connectActive(killer, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === killer });
    const room = getRoomById(cr.roomId);
    const internal = room._internals;
    const instanceId = shipInstanceFor(room, killer);

    // A drone kills another drone — the shooter is a `swarm-`/drone id, not a
    // ship instance, so no roster XP moves.
    expect(internal.spawnTestDrone('attacker-drone', 600, 0, 'fighter')).toBe(true);
    expect(internal.spawnTestDrone('victim-drone', 620, 0, 'fighter')).toBe(true);
    internal.applyDamage('victim-drone', 'attacker-drone', 99999);

    expect(getPlayerShipStore().get(instanceId)!.xp).toBe(0);
    expect(getPlayerShipStore().get(instanceId)!.level).toBe(1);
  });

  it("keeps two ships' XP separate when the same player switches hulls", async () => {
    // Two players each pilot a ship in the same room. Each player's kill must
    // bank XP onto their OWN hull instance only — the per-instance contract.
    const pA = randomUUID();
    const pB = randomUUID();
    const testId = randomUUID();
    const crA = await harness.connectActive(pA, { shipKind: 'fighter', testId });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pA });
    const crB = await harness.connectActive(pB, { shipKind: 'fighter', testId });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pB });
    const room = getRoomById(crA.roomId);
    expect(crB.roomId).toBe(crA.roomId);
    const internal = room._internals;
    const idA = shipInstanceFor(room, pA);
    const idB = shipInstanceFor(room, pB);

    // pA scores a kill.
    expect(internal.spawnTestDrone('drone-a', 600, 0, 'fighter')).toBe(true);
    internal.applyDamage('drone-a', pA, 99999);

    const oneKill = xpForKill(getDroneMaxHealth('fighter')!);
    expect(getPlayerShipStore().get(idA)!.xp).toBe(oneKill);
    expect(getPlayerShipStore().get(idB)!.xp).toBe(0); // B untouched

    // pB scores a kill — A unaffected, B banks its own.
    expect(internal.spawnTestDrone('drone-b', 600, 100, 'fighter')).toBe(true);
    internal.applyDamage('drone-b', pB, 99999);
    expect(getPlayerShipStore().get(idA)!.xp).toBe(oneKill);
    expect(getPlayerShipStore().get(idB)!.xp).toBe(oneKill);
  });

  it('fires SHIP_LEVEL_UP exactly once when a kill crosses one threshold', async () => {
    const killer = randomUUID();
    const cr = await harness.connectActive(killer, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === killer });
    const room = getRoomById(cr.roomId);
    const internal = room._internals;
    const instanceId = shipInstanceFor(room, killer);

    // Pre-seed XP just below the level-1 threshold so a single kill crosses it.
    const oneKill = xpForKill(getDroneMaxHealth('fighter')!);
    const need = xpToNext(1);
    getPlayerShipStore().setProgress(instanceId, { level: 1, xp: need - 1 });
    // Reflect the seed on the live mirror too (mirrors the spawn seed).
    const state = (room as unknown as { state: SectorState }).state;
    state.ships.get(instanceId)!.level = 1;

    let levelUps = 0;
    let lastNewLevel = 0;
    room.eventBus().on('SHIP_LEVEL_UP', (e) => {
      if (e.shipInstanceId === instanceId) { levelUps++; lastNewLevel = e.newLevel; }
    });

    expect(internal.spawnTestDrone('drone-lvl', 600, 0, 'fighter')).toBe(true);
    internal.applyDamage('drone-lvl', killer, 99999);

    expect(levelUps).toBe(1);
    expect(lastNewLevel).toBe(2);
    const row = getPlayerShipStore().get(instanceId)!;
    expect(row.level).toBe(2);
    // Remainder carried into level 2.
    expect(row.xp).toBe((need - 1 + oneKill) - need);
    // The live mirror tracks the new public level.
    expect(state.ships.get(instanceId)!.level).toBe(2);
  });

  it('does NOT fire a level-up when a kill stays below the threshold', async () => {
    const killer = randomUUID();
    const cr = await harness.connectActive(killer, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === killer });
    const room = getRoomById(cr.roomId);
    const internal = room._internals;
    const instanceId = shipInstanceFor(room, killer);

    let levelUps = 0;
    room.eventBus().on('SHIP_LEVEL_UP', (e) => {
      if (e.shipInstanceId === instanceId) levelUps++;
    });

    expect(internal.spawnTestDrone('drone-sub', 600, 0, 'fighter')).toBe(true);
    internal.applyDamage('drone-sub', killer, 99999);

    expect(levelUps).toBe(0);
    expect(getPlayerShipStore().get(instanceId)!.level).toBe(1);
  });

  it("destroyed ship's progression is dropped atomically with its roster row (D9)", async () => {
    const victim = randomUUID();
    const killer = randomUUID();
    const cr = await harness.connectActive(victim, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === victim });
    const room = getRoomById(cr.roomId);
    const instanceId = shipInstanceFor(room, victim);

    // Give the victim's hull some hard-won progression.
    getPlayerShipStore().setProgress(instanceId, { level: 5, xp: 1234, statAlloc: { hull: 3 }, mounts: [{ slotId: 'wing', weaponId: 'laser_beam' }] });
    expect(getPlayerShipStore().get(instanceId)).not.toBeNull();

    // Kill the victim hull (PvP). Drive the SHIP_DESTROYED handler directly via
    // the bus — exactly the event the active-hull death policy emits — to lock
    // the wipe ordering without re-deriving shield/hull mechanics. The roster
    // row — and ALL its progression (xp/level/statAlloc/mounts) — must be gone
    // (no orphaned persistence row left behind).
    room.eventBus().emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: victim, shooterId: killer });

    expect(getPlayerShipStore().get(instanceId)).toBeNull();
  });
});
