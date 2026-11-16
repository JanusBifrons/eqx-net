/**
 * The size ladder (owner 2026-11-16, plan partitioned-chasing-lark), through
 * the real room: every salvage piece carries its size tier on the wire lock
 * (`f`, `lockTierOf`: the smallest mount size whose tractor pulls it, from
 * its mass alone), and a mining laser fires only at the MATCHING size (owner
 * 2026-11-16): a size-k laser cuts tier k+1 pieces, an XL laser a whole
 * rock (tier none), and when the ship has no laser of the size a piece
 * needs, its next smaller laser stands in. Two laser sizes on one ship, both
 * groups locked on one rock: the XL laser cuts the whole rock (no tractor
 * pulls it), the locks follow its pieces, and those pieces (light enough for
 * a tractor, heavier than an AA one pulls) the XL laser leaves while the AA
 * laser, standing in for the S/M/L sizes the ship lacks, cuts them.
 *
 * No ship kind carries mining lasers of two sizes yet (the barge): a gunship
 * with its `forward` gun swapped to an XL mining laser and its `rear` gun to
 * an AA one (both slewing all round), and each group given room for two
 * locks, in-process, restored after. Fire goes through the real lock and
 * fire gate (no bypass).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind, type WeaponMount } from '../../../src/shared-types/shipKinds.js';
import { LOCK_SALVAGE, lockTierOf } from '../../../src/core/combat/turretLockPick.js';
import { SALVAGE_TIER_NONE, mountTier } from '../../../src/core/combat/salvageTargeting.js';

interface SnapGroups { id: string; m: number; l: Array<{ t: string; s: number; p: number; f?: number }> }

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — the size ladder: laser sizes work pieces by tier', () => {
  let harness: SectorTestHarness;
  const mounts = getShipKind('gunship').mounts as Array<WeaponMount & { size?: WeaponMount['size'] }>;
  const saved = mounts.map((m) => ({ weaponId: m.weaponId, size: m.size, arcMin: m.arcMin, arcMax: m.arcMax }));
  const slots = getShipKind('gunship').slots as Array<{ lockCapacity?: number }>;
  afterEach(async () => {
    mounts.forEach((m, i) => {
      m.weaponId = saved[i]!.weaponId; m.arcMin = saved[i]!.arcMin; m.arcMax = saved[i]!.arcMax;
      if (saved[i]!.size === undefined) delete m.size; else m.size = saved[i]!.size;
    });
    for (const s of slots) delete s.lockCapacity;
    if (harness) await harness.cleanup();
  }, 10_000);

  it('an XL laser cuts a rock no tractor pulls, then leaves its tractor-sized pieces to the AA laser, which cuts them', async () => {
    for (const m of mounts) {
      m.weaponId = 'mining_laser'; m.size = m.id === 'forward' ? 'XL' : 'AA';
      m.arcMin = -Math.PI; m.arcMax = Math.PI; // both turrets bear on the rock ahead
    }
    for (const s of slots) s.lockCapacity = 2; // each group holds both targets
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [], subcapWrecks: true,
    });
    const pid = randomUUID();
    const client = (await harness.connectActive(pid, {
      shipKind: 'gunship', spawnX: 0, spawnY: 0, groupMode: 'manual', initialHull: 100_000,
    })) as ClientRoom<SectorState>;
    let groups: SnapGroups[] | undefined;
    client.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pid && st.groups) groups = st.groups;
    });
    const acks = new Map<string, boolean>(); // clientShotId → rejected
    client.onMessage('hit_ack', (m: { clientShotId: string; rejected?: boolean }) => acks.set(m.clientShotId, m.rejected === true));
    for (const t of ['damage', 'laser_fired', 'swarm', 'destroy', 'loot_collected']) client.onMessage(t, () => {});
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;

    // A rock off the bow: whole, no tractor pulls it (tier none), so every laser may cut it.
    expect(int().spawnTestAsteroid('rock-1', 0, 900, 45)).toBe(true);
    await harness.advance(100);
    const rockKey = `s:${int().swarmRegistry.get('rock-1')!.entityId}`;
    for (const g of ['fore', 'aft']) harness.lockTarget(pid, 'rock-1', g);
    const locksOf = (g: string): SnapGroups['l'] => groups?.find((x) => x.id === g)?.l.filter((l) => l.s === 2) ?? [];
    await waitUntil(() => ['fore', 'aft'].every((g) => locksOf(g).some((l) => l.t === rockKey && l.f !== undefined)), 5_000, 'rock locks on the wire');
    expect(locksOf('fore')[0]!.f, 'a whole rock: salvage, tier none').toBe(LOCK_SALVAGE);

    const fire = (id: string, slotId: string): void => {
      client.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: id, weapon: 'hitscan', dirAngle: 0, slotId });
    };
    // 1. The XL laser cuts the rock apart; each group's lock follows the two biggest pieces.
    for (let i = 0; i < 60 && int().swarmRegistry.get('rock-1') != null; i++) {
      fire(`r${i}`, 'fore'); await new Promise((r) => setTimeout(r, 120));
    }
    expect(int().swarmRegistry.get('rock-1') ?? null, 'the XL laser cut the rock').toBeNull();
    const pieceLocks = (g: string): SnapGroups['l'] => locksOf(g).filter((l) => l.t !== rockKey && l.f !== undefined);
    await waitUntil(() => ['fore', 'aft'].every((g) => pieceLocks(g).length > 0), 5_000, 'locks on the pieces');
    const tiers = pieceLocks('fore').map((l) => lockTierOf(l.f!));
    // Pieces a tractor can pull, above the AA rung: the XL laser leaves them, the AA laser cuts them.
    for (const t of tiers) {
      expect(t, 'a piece some tractor pulls').not.toBe(SALVAGE_TIER_NONE);
      expect(t, 'heavier than an AA tractor pulls').toBeGreaterThan(mountTier('AA'));
    }
    const ids = pieceLocks('fore').map((l) => [...int().swarmRegistry.all()].find((r) => `s:${r.entityId}` === l.t)!.id);
    const wear = (): string => ids.map((id) => String(int().wreckIntegrity(id))).join(',');

    // 2. The XL laser has no piece it may cut: no aim, every shot refused, no wear.
    const wear0 = wear();
    for (let i = 0; i < 8; i++) { fire(`x${i}`, 'fore'); await new Promise((r) => setTimeout(r, 120)); }
    await waitUntil(() => [...acks.keys()].filter((k) => k.startsWith('x')).length >= 8, 4_000, 'acks (XL)');
    expect([...acks].filter(([id, rej]) => id.startsWith('x') && !rej), 'the XL laser leaves tractor-sized pieces').toEqual([]);
    expect(wear(), 'no wear from the XL laser').toBe(wear0);

    // 3. The AA laser (the ship's next smaller size), on the same pieces, cuts them.
    for (let i = 0; i < 12 && wear() === wear0; i++) { fire(`a${i}`, 'aft'); await new Promise((r) => setTimeout(r, 120)); }
    await waitUntil(() => wear() !== wear0, 4_000, 'the AA laser cuts a piece');
    expect([...acks].some(([id, rej]) => id.startsWith('a') && !rej), 'the AA laser fires').toBe(true);
  }, 60_000);
});
