/**
 * Economy v2 W1 (plan peppy-jumping-pinwheel) — credits are VIRTUAL.
 *
 * Through a real SectorRoom and the real damage path:
 *  1. killing an NPC pays its kill BOUNTY straight into the killer's wallet;
 *     the loot pod it drops carries goods only (never credits);
 *  2. the pilot sees the balance on their OWN snapshot entry (`wallet`, #16):
 *     the HUD converges from the snapshot alone (a late joiner / a dropped
 *     message can't desync it);
 *  3. a non-player killer (another NPC) earns nobody anything.
 *
 * Fails on the pre-W1 code: credits rode in the pod and no `wallet` existed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import { getHoldStore, getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { lootTableFor } from '../../../src/shared-types/lootTables.js';

function room(id: string): SectorRoom {
  return matchMaker.getLocalRoomById(id) as unknown as SectorRoom;
}

describe('SectorRoom integration — the wallet (economy v2 W1)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('an NPC kill pays the killer\'s wallet; pods carry no credits; the snapshot carries the balance', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { shipKind: 'fighter' });
    const r = room(cr.roomId);
    const internal = r._internals;
    expect(getWallet().balance(pid)).toBe(0);

    // A robot cube: bounty range 8–20.
    expect(internal.spawnTestDrone('victim-cube', 600, 0, 'robot-square')).toBe(true);
    for (let i = 0; i < 10 && internal.swarmRegistry.get('victim-cube'); i++) internal.applyDamage('victim-cube', pid, 99_999);
    expect(internal.swarmRegistry.get('victim-cube') ?? null).toBeNull();
    const [lo, hi] = lootTableFor('robot-square').bounty;
    const bal = getWallet().balance(pid);
    expect(bal).toBeGreaterThanOrEqual(lo);
    expect(bal).toBeLessThanOrEqual(hi);

    // Its pod carries goods only.
    const pods = getHoldStore().inSector('sol-prime', 'pod');
    expect(pods.length).toBeGreaterThan(0);
    expect(pods.every((p) => !('credits' in p.hold))).toBe(true);

    // The own snapshot entry carries the balance (#16).
    const state = r.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    harness.sendThrust(cr);
    let seen: number | undefined;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && seen !== bal) {
      const snap: SnapshotMessage = await harness.waitForSnapshot(cr, 2_000);
      seen = snap.states?.[shipId]?.wallet;
    }
    expect(seen).toBe(bal);
  });

  it('an NPC killed by another NPC pays nobody', { timeout: 30_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { shipKind: 'fighter' });
    const internal = room(cr.roomId)._internals;
    expect(internal.spawnTestDrone('victim-2', 600, 0, 'robot-square')).toBe(true);
    for (let i = 0; i < 10 && internal.swarmRegistry.get('victim-2'); i++) internal.applyDamage('victim-2', 'swarm-77', 99_999);
    expect(getWallet().balance(pid)).toBe(0);
    expect(getWallet().balance('swarm-77')).toBe(0);
  });
});
