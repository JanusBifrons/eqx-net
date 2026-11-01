/**
 * Living World P1a-1 (plan peppy-jumping-pinwheel) — the loot loop end to end
 * through a real SectorRoom:
 *
 *  1. a combat-killed drone drops a loot pod where it died;
 *  2. flying over a pod moves its contents into the ship's hold, and the hold
 *     reaches the client on the OWN-ship snapshot slice (invariant #16);
 *  3. hardcore: when that ship dies, its hold spills as a pod and the ship hold
 *     is gone (no duplication).
 *
 * Bespoke triggers, no game-time waits: `_internals.applyDamage` kills, the
 * pod is seeded next to the ship, `initialCargo` seeds a hold.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages/snapshotMessages.js';
import { getHoldStore, getPlayerShipStore, getWallet } from '../../../src/server/db/PersistenceWorker.js';

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

describe('SectorRoom integration — loot loop (P1a-1)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a killed drone drops a pod; flying over it fills the hold (seen in the own-ship snapshot)', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { spawnX: 0, spawnY: 0 });
    const r = room(cr.roomId);
    const internal = r._internals;

    // 1) A drone dies far from the player → a pod appears where it died.
    expect(internal.spawnTestDrone('loot-drone', 2000, 2000)).toBe(true);
    for (let i = 0; i < 10 && internal.swarmRegistry.get('loot-drone'); i++) {
      internal.applyDamage('loot-drone', 'someone', 9999);
    }
    expect(internal.swarmRegistry.get('loot-drone') ?? null).toBeNull();
    expect(internal.loot.podCount(), 'a combat kill must drop a loot pod').toBe(1);

    // 2) Seed a pod right next to the ship → the collector picks it up.
    internal.loot.drop({ goods: { salvage: 7 }, blueprints: [] }, 20, 0);
    const state = r.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');
    const picked = await until(() => (getHoldStore().get(shipId)?.hold.goods.salvage ?? 0) >= 7, 5_000);
    expect(picked, 'flying over a pod must move it into the ship hold').toBe(true);

    // The own-ship snapshot slice carries the authoritative cargo (#16).
    harness.sendThrust(cr);
    let sawCargo = false;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !sawCargo) {
      const snap: SnapshotMessage = await harness.waitForSnapshot(cr, 2_000);
      const own = snap.states?.[shipId];
      if (own?.cargo && (own.cargo.goods['salvage'] ?? 0) >= 7) sawCargo = true;
    }
    expect(sawCargo, 'the own-ship snapshot entry must carry cargo').toBe(true);
  });

  it('hardcore: a ship that dies carrying cargo spills it as a pod and keeps nothing — but the WALLET is untouched',{ timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      spawnX: 500, spawnY: 500,
      initialCargo: { goods: { alloy: 3 }, blueprints: [] },
      initialWallet: 120,
    });
    const r = room(cr.roomId);
    const internal = r._internals;
    const state = r.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    expect(getHoldStore().get(shipId)?.hold.goods.alloy).toBe(3);
    expect(getWallet().balance(pid)).toBe(120);
    const podsBefore = internal.loot.podCount();

    for (let i = 0; i < 10 && state.ships.get(shipId)?.alive !== false; i++) {
      internal.applyDamage(pid, 'killer', 99999);
    }
    expect(getHoldStore().get(shipId), 'the dead ship must keep NOTHING (no duplication)').toBeUndefined();
    expect(internal.loot.podCount()).toBe(podsBefore + 1);
    let spilled = 0;
    for (const id of internal.loot.podIds()) spilled += getHoldStore().get(id)?.hold.goods.alloy ?? 0;
    expect(spilled).toBe(3);
    // Economy v2 — credits are virtual: dying can never lose them.
    expect(getWallet().balance(pid)).toBe(120);
  });

  it('P1a-2: abandoning a ship carrying cargo leaves a salvageable DERELICT', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      spawnX: -600, spawnY: 300,
      initialCargo: { goods: { salvage: 12 }, blueprints: [] },
    });
    const r = room(cr.roomId);
    const internal = r._internals;
    const state = r.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;

    // Abandon = the roster row is deleted while the hull is alive (the poll reaps it).
    getPlayerShipStore().delete(shipId);
    const reaped = await until(() => state.ships.get(shipId) === undefined, 8_000);
    expect(reaped).toBe(true);
    expect(getHoldStore().get(shipId), 'the abandoned ship keeps nothing').toBeUndefined();
    const derelicts = [...internal.loot.podIds()].filter((id) => internal.loot.isDerelict(id));
    expect(derelicts, 'its hold becomes a derelict hulk').toHaveLength(1);
    expect(getHoldStore().get(derelicts[0]!)?.hold.goods.salvage).toBe(12);
  });
});

// Economy v2 W4a — its own boot with no asteroid field (the Capital footprint
// would overlap the default rocks near the origin).
describe('SectorRoom integration — packed loot (economy v2 W4a)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('economy v2 W4a: a looted PACKED structure rides the pod into the hold, the own-ship snapshot, then base storage', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { spawnX: 0, spawnY: 0 });
    const r = room(cr.roomId);
    const internal = r._internals;
    const state = r.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;

    internal.loot.drop({ goods: {}, blueprints: [], packed: [{ product: 'structure:smelter', quality: 42 }] }, 20, 0);
    const picked = await until(() => (getHoldStore().get(shipId)?.hold.packed?.length ?? 0) === 1, 5_000);
    expect(picked, 'the packed structure must move into the ship hold').toBe(true);
    let sawPacked = false;
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && !sawPacked) {
      const snap: SnapshotMessage = await harness.waitForSnapshot(cr, 2_000);
      if (snap.states?.[shipId]?.cargo?.packed?.[0]?.product === 'structure:smelter') sawPacked = true;
    }
    expect(sawPacked, 'the own-ship cargo slice must carry the packed item (#16)').toBe(true);

    // Park next to my own Capital: the dwell deposit banks it.
    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 150, y: 0 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === pid), 5_000)).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === pid)!;
    const banked = await until(() => (cap.hold?.packed?.length ?? 0) === 1, 8_000);
    expect(banked, 'the dwell deposit must move the packed structure into storage').toBe(true);
    expect(cap.hold!.packed![0]).toEqual({ product: 'structure:smelter', quality: 42 });
    expect(getHoldStore().get(shipId)?.hold.packed ?? []).toEqual([]);
  });
});
