/**
 * The tractor WEAPON through the real room (salvage plan PR 11a). A pilot
 * whose mount carries the `tractor` weapon locks a target with the real lock
 * path (`lock_request` + `instantLock`) and fires through the real `fire`
 * message: the room's ForceFieldSubsystem holds a tractor field on that
 * target (force by mount size), the snapshot carries the tractor beam link
 * after the structure triples, the lease lapses `leaseTicks` after the last
 * fire, and the beam never deals damage. Terrain is neutral; tractoring a
 * ship is a hostile act like any weapon fire.
 *
 * No ship kind carries a tractor yet (the barge is PR 15), so the test swaps
 * the interceptor's mounts to `tractor` in-process and restores them after.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind, type WeaponMount } from '../../../src/shared-types/shipKinds.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import { MOUNT_SIZE_TUNING } from '../../../src/shared-types/shipScale/tuning.js';
import { forEachBeamLink } from '../../../src/shared-types/beamLinksWire.js';
import type { TractorForceField } from '../../../src/core/physics/forceFields.js';

interface SnapGroups { id: string; m: number; l: Array<{ t: string; s: number; p: number }> }

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — tractor beam weapon', () => {
  let harness: SectorTestHarness;
  const mounts = getShipKind('interceptor').mounts as WeaponMount[];
  const saved = mounts.map((m) => m.weaponId);
  afterEach(async () => {
    mounts.forEach((m, i) => { m.weaponId = saved[i]!; });
    if (harness) await harness.cleanup();
  }, 10_000);

  it('lock + fire on a rock holds a tractor field on it; the snapshot links it; it lapses without fire; no damage, no hostility', async () => {
    for (const m of mounts) m.weaponId = 'tractor';
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
    });
    const pid = randomUUID();
    const client = (await harness.connectActive(pid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, instantLock: true, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    let groups: SnapGroups[] | undefined;
    const links: Array<{ e: number | string; m: string; t: number | string; a: number; b: number }> = [];
    client.onMessage('snapshot', (snap: { structureTargets?: Array<number | string>; states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pid && st.groups) groups = st.groups;
      if (snap.structureTargets) {
        forEachBeamLink(snap.structureTargets, { structure: () => {}, tractor: (e, m, t, a, b) => links.push({ e, m, t, a, b }) });
      }
    });
    let damage = 0;
    client.onMessage('damage', () => { damage++; });
    client.onMessage('laser_fired', () => {});
    client.onMessage('hit_ack', () => {});
    client.onMessage('swarm', () => {});
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;

    // A rock dead ahead (+y is forward), and a peaceful NPC fighter.
    expect(int().spawnTestAsteroid('rock-1', 0, 400, 30)).toBe(true);
    expect(int().spawnTestDrone('bystander', 600, 600, 'fighter')).toBe(true);
    const rock = int().swarmRegistry.get('rock-1')!;
    const key = `s:${rock.entityId}`;
    client.send('lock_request', { type: 'lock_request', groupId: 'primary', target: key });
    harness.sendThrust(client);
    await waitUntil(() => groups?.[0]?.l.some((l) => l.t === key && l.s === 2) === true, 5_000, 'rock locked');
    harness.events.clear();

    const fire = (id: string): void => {
      client.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: id, weapon: 'hitscan', dirAngle: 0, slotId: 'primary' });
    };
    const fieldId = (m: WeaponMount): string => `tractor:${pid}:${m.id}`;
    fire('t1');
    await waitUntil(() => mounts.some((m) => int().forceFields.get(fieldId(m)) !== undefined), 3_000, 'tractor field set');
    const m = mounts.find((mm) => int().forceFields.get(fieldId(mm)) !== undefined)!;
    const f = int().forceFields.get(fieldId(m)) as TractorForceField;
    expect(f.kind).toBe('tractor');
    expect(f.target).toBe('rock-1');
    expect(f.emitter).toBe(pid);
    expect(f.force).toBe(getWeapon('tractor').tractor!.force * MOUNT_SIZE_TUNING[m.size ?? 'S'].power);
    expect(f.active).toBe(true);
    expect(f.lineCount).toBe(0); // nothing else on the beam line
    await waitUntil(() => links.some((l) => l.e === pid && l.t === rock.entityId), 3_000, 'snapshot beam link');
    const link = links.find((l) => l.e === pid)!;
    expect(link.b - link.a).toBeGreaterThanOrEqual(getWeapon('tractor').tractor!.leaseTicks);

    // No fire ⇒ the lease lapses and the field is removed.
    await waitUntil(() => int().forceFields.tractorCount === 0, 3_000, 'lease lapsed');
    expect(int().forceFields.get(fieldId(m))).toBeUndefined();

    expect(damage, 'a tractor deals no damage').toBe(0);
    expect(harness.events.count({ tag: 'lock_hostile_act' }), 'tractoring terrain is no hostile act').toBe(0);
    expect(int().npcHostileTo('bystander', pid)).toBe(false);
  }, 30_000);
});
