/**
 * Hold-zone pickup through the real room (salvage plan PR 12). A loot pod
 * held in a ship's tractor beam within `TRACTOR_PICKUP_HOLD_MUL × hold` of the
 * beam's muzzle goes into that ship's hold through LootSubsystem's one atomic
 * pickup, exactly as if flown over. The same pod at the same distance with no
 * beam on it stays put (it is outside the fly-over radius), and a full hold
 * leaves the tractored pod hovering.
 *
 * No ship kind carries a tractor yet (the barge is PR 15), so the test swaps
 * the interceptor's mounts to `tractor` in-process and restores them after
 * (the tractorBeam.test.ts pattern).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind, type WeaponMount } from '../../../src/shared-types/shipKinds.js';
import { cargoCapacityForMaxHealth } from '../../../src/shared-types/goods.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import { LOOT_PICKUP_RADIUS } from '../../../src/server/cargo/LootSubsystem.js';
import { TRACTOR_PICKUP_HOLD_MUL } from '../../../src/server/rooms/ForceFieldSubsystem.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';

interface SnapGroups { id: string; m: number; l: Array<{ t: string; s: number; p: number }> }

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

const HOLD = getWeapon('tractor').tractor!.hold;
/** Inside the hold zone, outside the fly-over radius. */
const POD_DIST = HOLD * 1.1;

describe('SectorRoom integration — tractor hold-zone pickup', () => {
  let harness: SectorTestHarness;
  const mounts = getShipKind('interceptor').mounts as WeaponMount[];
  const saved = mounts.map((m) => m.weaponId);
  afterEach(async () => {
    mounts.forEach((m, i) => { m.weaponId = saved[i]!; });
    if (harness) await harness.cleanup();
  }, 10_000);

  async function setup(initialCargo?: { goods: Record<string, number>; blueprints: [] }): Promise<{
    pid: string; client: ClientRoom<SectorState>; int: () => SectorRoom['_internals']; shipId: () => string;
    groups: () => SnapGroups[] | undefined;
  }> {
    for (const m of mounts) m.weaponId = 'tractor';
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
    });
    const pid = randomUUID();
    const client = (await harness.connectActive(pid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, instantLock: true, groupMode: 'manual',
      ...(initialCargo ? { initialCargo } : {}),
    })) as ClientRoom<SectorState>;
    let groups: SnapGroups[] | undefined;
    client.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pid && st.groups) groups = st.groups;
    });
    for (const t of ['damage', 'laser_fired', 'hit_ack', 'swarm', 'loot_collected']) client.onMessage(t, () => {});
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;
    const shipId = (): string => {
      for (const [, s] of (room.state as SectorState).ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
      return '';
    };
    return { pid, client, int, shipId, groups: () => groups };
  }

  /** Lock pod `podId` with the real lock path, then keep firing the tractor
   *  (a lease spans ~12 ticks) until `done` or the timeout. */
  async function tractorUntil(
    s: Awaited<ReturnType<typeof setup>>, podId: string, done: () => boolean, ms: number,
  ): Promise<boolean> {
    const rec = s.int().swarmRegistry.get(podId)!;
    const key = `s:${rec.entityId}`;
    s.client.send('lock_request', { type: 'lock_request', groupId: 'primary', target: key });
    harness.sendThrust(s.client); // wake the snapshot loop (the lock state rides it)
    expect(await until(() => s.groups()?.[0]?.l.some((l) => l.t === key && l.s === 2) === true, 5_000), 'pod locked').toBe(true);
    const end = Date.now() + ms;
    let n = 0;
    while (Date.now() < end && !done()) {
      s.client.send('fire', { type: 'fire', tick: s.int().serverTick, clientShotId: `t${n++}`, weapon: 'hitscan', dirAngle: 0, slotId: 'primary' });
      await new Promise((r) => setTimeout(r, 100));
    }
    return done();
  }

  it('a tractored pod near the emitter is picked up; the same pod untractored at that distance is not', async () => {
    expect(POD_DIST, 'test geometry: the pod sits outside the fly-over radius').toBeGreaterThan(LOOT_PICKUP_RADIUS + 20);
    expect(POD_DIST).toBeLessThan(HOLD * TRACTOR_PICKUP_HOLD_MUL);
    const s = await setup();
    const podId = s.int().loot.drop({ goods: { salvage: 7 }, blueprints: [] }, 0, POD_DIST);
    expect(podId).not.toBeNull();
    const id = s.shipId();
    expect(id).not.toBe('');

    // Untractored at POD_DIST: several collect passes (10 Hz) leave it alone.
    await new Promise((r) => setTimeout(r, 800));
    expect(s.int().loot.isPod(podId!), 'an untractored pod beyond the fly-over radius stays').toBe(true);
    expect(getHoldStore().get(id)?.hold.goods.salvage ?? 0).toBe(0);

    // Tractored: the atomic pickup moves it into the emitter's hold.
    const picked = await tractorUntil(s, podId!, () => !s.int().loot.isPod(podId!), 5_000);
    expect(picked, 'a tractored pod in the hold zone is picked up').toBe(true);
    expect(getHoldStore().get(id)?.hold.goods.salvage).toBe(7);
    expect(getHoldStore().get(podId!), 'the pod row is gone (moved, not copied)').toBeUndefined();
    expect(s.int().swarmRegistry.get(podId!) ?? null, 'the pod entity is despawned').toBeNull();
  }, 30_000);

  it('a full hold leaves the tractored pod hovering', async () => {
    const cap = cargoCapacityForMaxHealth(getShipKind('interceptor'));
    const s = await setup({ goods: { salvage: cap }, blueprints: [] });
    const podId = s.int().loot.drop({ goods: { salvage: 5 }, blueprints: [] }, 0, POD_DIST)!;
    expect(podId).not.toBeNull();
    const id = s.shipId();

    // Hold the beam on it well past several collect passes.
    let tractored = false;
    await tractorUntil(s, podId, () => {
      if (s.int().forceFields.tractorCount > 0) tractored = true;
      return false;
    }, 1_500);
    expect(tractored, 'the beam held the pod').toBe(true);
    expect(s.int().loot.isPod(podId), 'a full hold leaves the pod in the world').toBe(true);
    expect(getHoldStore().get(podId)?.hold.goods.salvage).toBe(5);
    expect(getHoldStore().get(id)?.hold.goods.salvage).toBe(cap);
  }, 30_000);
});
