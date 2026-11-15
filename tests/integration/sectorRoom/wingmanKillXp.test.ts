/**
 * RTS command layer — a wingman's kill earns XP for the HULL that made it (D8).
 *
 * A parked (lingering) hull fires under its shipInstanceId. Before the fix,
 * `awardKillXp` resolved that id as a playerId (`resolveActiveShipKey`), found
 * nothing, and the kill earned no XP at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { mountWeaponReach } from '../../../src/core/combat/mountReach.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';

describe('SectorRoom integration — wingman kill XP', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  // RTS Part B slice 6: hunt + attitude: engage a drone hostile to the OWNER (here via `test_aggro`).
  it.skip("the wingman hull's roster row gains the kill XP", async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, instantLock: true });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    let sid = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    expect(sid).not.toBe('');
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    const internals = room._internals;
    expect(internals.fleet.isAttached(sid)).toBe(true);
    expect(getPlayerShipStore().get(sid)!.xp).toBe(0);

    let reach = 0;
    for (const m of getShipKind('fighter').mounts ?? []) reach = Math.max(reach, mountWeaponReach(m));
    expect(internals.spawnTestDrone('foe', 0, Math.max(80, reach * 0.5), 'fighter')).toBe(true);
    internals.swarmHealth.set('foe', 1); // one hit kills
    client.send('test_aggro', { type: 'test_aggro' });
    await harness.advance(100);
    internals.fleet.setStance(pid, [sid], 'aggressive');
    internals.fleet.setMode(pid, [sid], 'hunt');

    for (let i = 0; i < 40 && internals.swarmHealth.has('foe'); i++) await harness.advance(250);
    expect(internals.swarmHealth.has('foe'), 'the wingman killed the drone').toBe(false);

    const row = getPlayerShipStore().get(sid)!;
    expect(row.level > 1 ? 1 : row.xp, 'the hull earned XP').toBeGreaterThan(0);
    // The owner flies nothing now; no other roster row of theirs gained XP.
    for (const r of getPlayerShipStore().listByPlayer(pid)) if (r.shipId !== sid) expect(r.xp).toBe(0);
    await harness.disconnectClient(client);
  }, 60_000);
});
