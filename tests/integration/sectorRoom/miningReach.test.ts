/**
 * The mining-tool range gradient (owner 2026-11-16, plan partitioned-chasing-lark),
 * through the real room: a mining laser's reach scales with its mount size
 * (`mountWeaponReach`: XL keeps 12,000 u, S ≈ 5,455 u). A rock 8,000 u off
 * the bow: the XL laser fires on it, the S laser on the same ship and the same
 * lock is refused by the player fire gate (`PlayerFireResolver` →
 * `SectorRoom.mountBearsOnLock`), spending nothing.
 *
 * No ship kind carries mining lasers of two sizes yet: a gunship with its
 * `forward` gun swapped to an XL mining laser and its `rear` gun to an S one
 * (both slewing all round), in-process, restored after (pattern:
 * sizeLadder.test.ts). Fire goes through the real lock and fire gate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind, type WeaponMount } from '../../../src/shared-types/shipKinds.js';
import { mountWeaponReach } from '../../../src/core/combat/mountReach.js';

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — mining laser reach by mount size', () => {
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

  it('an S mining laser is refused at a range an XL one fires at', async () => {
    for (const m of mounts) {
      m.weaponId = 'mining_laser'; m.size = m.id === 'forward' ? 'XL' : 'S';
      m.arcMin = -Math.PI; m.arcMax = Math.PI; // both turrets bear on the rock ahead
    }
    const D = 8_000;
    expect(mountWeaponReach({ weaponId: 'mining_laser', size: 'S' })).toBeLessThan(D - 100);
    expect(mountWeaponReach({ weaponId: 'mining_laser', size: 'XL' })).toBeGreaterThan(D + 100);

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

    expect(int().spawnTestAsteroid('rock-far', 0, D, 45)).toBe(true);
    await harness.advance(100);
    for (const g of ['fore', 'aft']) harness.lockTarget(pid, 'rock-far', g);
    await harness.advance(300); // the turrets slew onto the rock

    const fire = (id: string, slotId: string): void => {
      client.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: id, weapon: 'hitscan', dirAngle: 0, slotId });
    };
    // The S laser: every shot refused (out of its reach).
    for (let i = 0; i < 6; i++) { fire(`s${i}`, 'aft'); await new Promise((r) => setTimeout(r, 120)); }
    await waitUntil(() => [...acks.keys()].filter((k) => k.startsWith('s')).length >= 6, 4_000, 'acks (S)');
    expect([...acks].filter(([id, rej]) => id.startsWith('s') && !rej), 'the S laser is out of reach').toEqual([]);

    // The XL laser, same rock, same distance: fires.
    for (let i = 0; i < 12 && ![...acks].some(([id, rej]) => id.startsWith('x') && !rej); i++) {
      fire(`x${i}`, 'fore'); await new Promise((r) => setTimeout(r, 120));
    }
    await waitUntil(() => [...acks].some(([id, rej]) => id.startsWith('x') && !rej), 4_000, 'the XL laser fires');
  }, 60_000);
});
