/**
 * The factory line (owner 2026-11-16, plan partitioned-chasing-lark), through
 * the real room: a wreck piece small enough for THIS ship to take in whole
 * (`salvageConsumable`: hold size, the AA tier, on a ship with a mining
 * tool; fits the free hold) is targeted by nothing. The lock step stamps
 * `LOCK_CONSUMABLE` on the wire lock (`f`), the mining laser group's fire is
 * refused (`pickTurretLock` → `TURRET_NO_LOCK`) and the tractor group's too
 * (no lease). Fill the hold and the same piece is pulled again (the control:
 * fighter debris is AA tier, so the S tractor pulls it and the S laser leaves
 * it, the size ladder). A consumable piece TOUCHING the hull (its real
 * shape, `shipWithinHullReach`) goes into the hold through the loot
 * pickup's piece store, with no tractor on it.
 *
 * No ship kind carries both tools yet (the barge is PR 15): a crossguard
 * (the biggest playable hull, r 213: it consumes fighter debris), its
 * `port` gun swapped to a mining laser and its `starboard` gun to a tractor
 * in-process, restored after.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind, type WeaponMount } from '../../../src/shared-types/shipKinds.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { LOCK_CONSUMABLE, LOCK_SALVAGE, LOCK_TIER_MASK } from '../../../src/core/combat/turretLockPick.js';
import { shipWithinHullReach } from '../../../src/core/combat/shipHitShape.js';

interface SnapGroups { id: string; m: number; l: Array<{ t: string; s: number; p: number; f?: number }> }
const WRECK_KIND = 4;

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — the factory line: nothing targets a consumable piece; the ship takes it in', () => {
  let harness: SectorTestHarness;
  const kind = getShipKind('crossguard');
  const mounts = kind.mounts as WeaponMount[];
  const saved = mounts.map((m) => m.weaponId);
  afterEach(async () => {
    mounts.forEach((m, i) => { m.weaponId = saved[i]!; });
    if (harness) await harness.cleanup();
  }, 10_000);

  it('laser and tractor leave a consumable piece; a full hold hands it back to the tractor; one at the hull goes into the hold', async () => {
    for (const m of mounts) m.weaponId = m.id === 'cross-l' ? 'mining_laser' : 'tractor';
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [], subcapWrecks: true, keepAllOnDeath: true,
    });
    const pid = randomUUID();
    const client = (await harness.connectActive(pid, {
      shipKind: 'crossguard', spawnX: 0, spawnY: 0, groupMode: 'manual', initialHull: 1_000_000,
    })) as ClientRoom<SectorState>;
    let groups: SnapGroups[] | undefined;
    client.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pid && st.groups) groups = st.groups;
    });
    const acks = new Map<string, boolean>(); // clientShotId → rejected
    client.onMessage('hit_ack', (m: { clientShotId: string; rejected?: boolean }) => acks.set(m.clientShotId, m.rejected === true));
    for (const t of ['damage', 'laser_fired', 'swarm', 'destroy']) client.onMessage(t, () => {});
    let salvageLoads = 0; // loot_collected popups carrying salvage
    client.onMessage('loot_collected', (m: { goods?: Record<string, number> }) => { if ((m.goods?.salvage ?? 0) > 0) salvageLoads++; });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;
    const ship = [...room.state.ships.values()].find((s) => s.playerId === pid)!;
    const hold = (): Record<string, number> => (getHoldStore().get(ship.shipInstanceId)?.hold.goods ?? {}) as Record<string, number>;

    /** Every wreck piece id seen live so far. */
    const seen = new Set<string>();
    const look = (): void => { for (const r of int().swarmRegistry.all()) if (r.kind === WRECK_KIND) seen.add(r.id); };
    /** Kill fighter `id` at (x, y) with a heavy bolt from +x; the wreck pieces it left. */
    const breakFighter = async (id: string, x: number, y: number): Promise<string[]> => {
      expect(int().spawnTestDrone(id, x, y, 'fighter')).toBe(true);
      await harness.advance(100);
      look();
      const before = new Set(seen);
      const at = int().wreckState(id)!;
      int().spawnTestProjectile('shooter-x', at.x + 600, at.y, -4000, 0, 'laser', 1e6);
      for (let t = 0; t < 40 && int().swarmRegistry.get(id); t++) { await harness.advance(50); look(); }
      look();
      expect(int().swarmRegistry.get(id) ?? null, `${id} died`).toBeNull();
      const ids = [...seen].filter((p) => !before.has(p));
      for (const pod of [...int().loot.podIds()]) int().loot.expireNow(pod); // its loot drop is not under test
      return ids;
    };

    // 1. A fighter well ahead of the bow (beyond the pickup reach, inside laser reach).
    const ahead = await breakFighter('f1', 0, kind.radius + 600);
    expect(ahead.length, 'the fighter broke into wreck pieces').toBeGreaterThan(0);
    const piece = ahead[0]!;
    const key = `s:${int().swarmRegistry.get(piece)!.entityId}`;
    harness.lockTarget(pid, piece, 'port');
    harness.lockTarget(pid, piece, 'starboard');
    const lockOf = (g: string): SnapGroups['l'][number] | undefined => groups?.find((x) => x.id === g)?.l.find((l) => l.t === key);
    await waitUntil(() => lockOf('port')?.s === 2 && lockOf('starboard')?.s === 2 && lockOf('port')?.f !== undefined, 5_000, 'both locks on the wire');
    expect((lockOf('port')!.f! & LOCK_CONSUMABLE), 'a small piece, an empty hold: consumable').toBe(LOCK_CONSUMABLE);

    const fire = (id: string, slotId: string): void => {
      client.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: id, weapon: 'hitscan', dirAngle: 0, slotId });
    };
    const integrity0 = int().wreckIntegrity(piece);
    for (let i = 0; i < 6; i++) { fire(`m${i}`, 'port'); fire(`t${i}`, 'starboard'); await new Promise((r) => setTimeout(r, 120)); }
    await waitUntil(() => [...acks.keys()].filter((k) => k.startsWith('m') || k.startsWith('t')).length >= 12, 4_000, 'acks (consumable)');
    expect([...acks].filter(([id, rej]) => (id.startsWith('m') || id.startsWith('t')) && !rej), 'no laser and no tractor fires at a consumable piece').toEqual([]);
    expect(int().wreckIntegrity(piece)).toBe(integrity0);
    expect(int().forceFields.tractorCount, 'no tractor lease on it').toBe(0);
    expect(int().swarmRegistry.get(piece), 'beyond the pickup reach it stays in the world').toBeTruthy();

    // 2. Control: fill the hold, the piece is no longer consumable, and the tractor pulls it (it is in range).
    getHoldStore().put({
      holderUid: ship.shipInstanceId, holderType: 'ship', ownerId: pid, sectorKey: 'sol-prime', x: null, y: null,
      hold: { goods: { salvage: 1_000_000 }, blueprints: [] }, expiresAt: null,
    }, false);
    await waitUntil(() => ((lockOf('port')?.f ?? 0) & ~LOCK_TIER_MASK) === LOCK_SALVAGE, 5_000, 'piece no longer consumable');
    for (let i = 0; i < 12 && ![...acks].some(([id, rej]) => id.startsWith('c') && !rej); i++) {
      fire(`c${i}`, 'starboard'); await new Promise((r) => setTimeout(r, 120));
    }
    await waitUntil(() => [...acks].some(([id, rej]) => id.startsWith('c') && !rej), 4_000, 'the tractor fires at the piece the ship can no longer take in');

    // 3. Empty hold, a fighter broken against the hull's side (+x, the bolt
    //    knocks its pieces onto it): they go into the hold whole through the
    //    loot pickup when they touch the hull, no tractor on them.
    getHoldStore().delete(ship.shipInstanceId, false);
    // (A piece can be taken in on the tick it spawns, before the test sees it: count loads, not ids.)
    const loads0 = salvageLoads;
    // Its shield is up: the bubble is the surface they meet.
    let side = 0;
    while (shipWithinHullReach(kind.id, true, side + 2, 0, 0, 0, 0, 0)) side += 2;
    await breakFighter('f2', side + 30, 0);
    // (Some may glance off the bubble and drift clear: those stay out; some go in before the test sees them.)
    await waitUntil(() => salvageLoads > loads0, 15_000, 'the pieces that touch the hull are taken in');
    expect(hold().salvage ?? 0, 'their salvage is in the hold').toBeGreaterThan(0);
    expect(int().forceFields.tractorCount, 'taken in with no tractor on them').toBe(0);
    expect(int().loot.podCount(), 'whole, no pod in between').toBe(0);
  }, 60_000);
});
