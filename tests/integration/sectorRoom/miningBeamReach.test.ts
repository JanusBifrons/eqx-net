/**
 * The mining laser's BEAM ends at its mount's sized reach (plan
 * partitioned-chasing-lark; owner 2026-11-16 range gradient). The fire gate
 * already scaled (`miningReach.test.ts`), but the server ray still ran the
 * catalogue's full 12,000 u: an S laser that fired at anything in its reach
 * went on to cut a rock 8,000 u out, past its ≈5,455 u reach.
 *
 * Through the real room: a gunship whose `forward` gun is an XL mining laser
 * and whose `rear` gun is an S one (both slewing all round; pattern
 * miningReach.test.ts), both groups locked on an ore pod 3,000 u ahead (in
 * either's reach, so both fire). A mining tool passes loot pods
 * (aiShotsSkipLootPods.test.ts), so each beam runs on down the line to a rock
 * 8,000 u out: the S beam stops short of it, the XL beam cuts it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind, type WeaponMount } from '../../../src/shared-types/shipKinds.js';
import { mountWeaponReach } from '../../../src/core/combat/mountReach.js';

type Hit = { target: string; shooter: string; weapon?: unknown };

function recordHits(room: unknown): Hit[] {
  const hits: Hit[] = [];
  const r = room as { applyDamage: (t: string, s: string, ...rest: unknown[]) => void };
  const orig = r.applyDamage.bind(r);
  r.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
    hits.push({ target: t, shooter: s, weapon: rest[5] });
    orig(t, s, ...rest);
  };
  return hits;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — mining laser beam length by mount size', () => {
  let harness: SectorTestHarness;
  const mounts = getShipKind('gunship').mounts as Array<WeaponMount & { size?: WeaponMount['size'] }>;
  const saved = mounts.map((m) => ({ weaponId: m.weaponId, size: m.size, arcMin: m.arcMin, arcMax: m.arcMax }));
  afterEach(async () => {
    mounts.forEach((m, i) => {
      m.weaponId = saved[i]!.weaponId; m.arcMin = saved[i]!.arcMin; m.arcMax = saved[i]!.arcMax;
      if (saved[i]!.size === undefined) delete m.size; else m.size = saved[i]!.size;
    });
    if (harness) await harness.cleanup();
  }, 10_000);

  it('an S laser\'s beam stops short of a rock past its reach; an XL one cuts it', async () => {
    for (const m of mounts) {
      m.weaponId = 'mining_laser'; m.size = m.id === 'forward' ? 'XL' : 'S';
      m.arcMin = -Math.PI; m.arcMax = Math.PI;
    }
    const POD = 3_000;
    const ROCK = 8_000;
    expect(mountWeaponReach({ weaponId: 'mining_laser', size: 'S' })).toBeGreaterThan(POD + 100);
    expect(mountWeaponReach({ weaponId: 'mining_laser', size: 'S' })).toBeLessThan(ROCK - 200);
    expect(mountWeaponReach({ weaponId: 'mining_laser', size: 'XL' })).toBeGreaterThan(ROCK + 200);

    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
    });
    const pid = randomUUID();
    const client = (await harness.connectActive(pid, {
      shipKind: 'gunship', spawnX: 0, spawnY: 0, groupMode: 'manual', initialHull: 100_000,
    })) as ClientRoom<SectorState>;
    const acks = new Map<string, boolean>(); // clientShotId → rejected
    client.onMessage('hit_ack', (m: { clientShotId: string; rejected?: boolean }) => acks.set(m.clientShotId, m.rejected === true));
    for (const t of ['snapshot', 'damage', 'laser_fired', 'swarm', 'destroy', 'loot_collected']) client.onMessage(t, () => {});
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;

    expect(int().spawnTestAsteroid('rock-far', 0, ROCK, 45)).toBe(true);
    const podId = int().loot.drop({ goods: { minerals: 5 }, blueprints: [] }, 0, POD, 0, 0);
    expect(podId, 'the pod spawned').toBeTruthy();
    await harness.advance(100);
    for (const g of ['fore', 'aft']) harness.lockTarget(pid, podId!, g);
    await harness.advance(300); // the turrets slew onto the pod
    const hits = recordHits(room);
    const onRock = (h: Hit): boolean => h.shooter === pid && h.weapon === 'mining_laser';

    const fire = (id: string, slotId: string): void => {
      client.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: id, weapon: 'hitscan', dirAngle: 0, slotId });
    };
    // The S laser fires (the pod is in its reach), but its beam ends short of the rock.
    for (let i = 0; i < 8; i++) { fire(`s${i}`, 'aft'); await new Promise((r) => setTimeout(r, 120)); }
    await waitUntil(() => [...acks.keys()].filter((k) => k.startsWith('s')).length >= 8, 4_000, 'acks (S)');
    expect([...acks].some(([id, rej]) => id.startsWith('s') && !rej), 'the S laser fired').toBe(true);
    expect(hits.filter(onRock), 'the S beam reached nothing').toEqual([]);

    // The XL laser, same pod, same rock: its beam runs on and cuts the rock.
    for (let i = 0; i < 16 && !hits.some(onRock); i++) {
      fire(`x${i}`, 'fore'); await new Promise((r) => setTimeout(r, 120));
    }
    await waitUntil(() => hits.some(onRock), 4_000, 'the XL beam cuts the rock');
    expect(hits.filter(onRock).every((h) => h.target !== podId), 'the beam passed the pod').toBe(true);
  }, 60_000);
});
