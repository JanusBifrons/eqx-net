/**
 * Mining lasers leave a piece a tractor of their own size can pull to the
 * tractors (owner 2026-11-16, the size ladder; salvage plan PR 16 wiring),
 * through the real room: the lock step stamps each lock's salvage bits
 * (`LockSubsystem` via the room's `salvageOf`: the wreck piece's mass gives
 * its size tier, `salvageTier`), the own-ship wire lock carries them (`f`),
 * and the fire gate (`aimKeyFor` → `pickTurretLock` → `TURRET_NO_LOCK`)
 * refuses the (S) laser's shots at an AA-tier piece, while the (S) tractor
 * locked on the same piece pulls it.
 *
 * No ship kind carries both yet (the barge is PR 15): a "barge-like"
 * gunship, its Fore turret swapped to a mining laser and its Aft turret to
 * a tractor (separate groups, both slewing all round) in-process, restored
 * after.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind, type WeaponMount } from '../../../src/shared-types/shipKinds.js';
import { LOCK_SALVAGE, lockTierBits } from '../../../src/core/combat/turretLockPick.js';
import { mountTier } from '../../../src/core/combat/salvageTargeting.js';

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

describe('SectorRoom integration — salvage lock bits gate the mining laser', () => {
  let harness: SectorTestHarness;
  const mounts = getShipKind('gunship').mounts as WeaponMount[];
  const saved = mounts.map((m) => ({ weaponId: m.weaponId, arcMin: m.arcMin, arcMax: m.arcMax }));
  afterEach(async () => {
    mounts.forEach((m, i) => { m.weaponId = saved[i]!.weaponId; m.arcMin = saved[i]!.arcMin; m.arcMax = saved[i]!.arcMax; });
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a laser locked on a piece a tractor its size can pull does not fire; the tractor does', async () => {
    for (const m of mounts) {
      m.weaponId = m.id === 'forward' ? 'mining_laser' : 'tractor';
      m.arcMin = -Math.PI; m.arcMax = Math.PI; // the aft tractor bears on the piece ahead too
    }
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
    for (const t of ['damage', 'laser_fired', 'swarm', 'destroy']) client.onMessage(t, () => {});
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;

    // A fighter dead ahead (+y forward) broken into wreck pieces by a heavy bolt.
    expect(int().spawnTestDrone('f1', 0, 700, 'fighter')).toBe(true);
    await harness.advance(100);
    const at = int().wreckState('f1')!;
    int().spawnTestProjectile('shooter-x', at.x - 600, at.y, 4000, 0, 'laser', 1e6);
    for (let t = 0; t < 40 && int().swarmRegistry.get('f1'); t++) await harness.advance(50);
    const pieces = [...int().swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);
    expect(pieces.length, 'the fighter broke into wreck pieces').toBeGreaterThan(0);
    const piece = pieces[0]!;
    const key = `s:${piece.entityId}`;

    harness.lockTarget(pid, piece.id, 'fore');
    harness.lockTarget(pid, piece.id, 'aft');
    const lockOf = (g: string): SnapGroups['l'][number] | undefined => groups?.find((x) => x.id === g)?.l.find((l) => l.t === key);
    const foreLock = (): SnapGroups['l'][number] | undefined => lockOf('fore');
    await waitUntil(() => foreLock()?.s === 2 && foreLock()?.f !== undefined && lockOf('aft')?.s === 2, 5_000, 'locks with salvage bits on the wire');
    expect(foreLock()!.f, 'fighter debris: an AA tractor pulls it').toBe(LOCK_SALVAGE | lockTierBits(mountTier('AA')));

    const fire = (id: string): void => {
      client.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: id, weapon: 'hitscan', dirAngle: 0, slotId: 'fore' });
    };
    const integrity0 = int().wreckIntegrity(piece.id);
    for (let i = 0; i < 8; i++) { fire(`h${i}`); await new Promise((r) => setTimeout(r, 120)); }
    await waitUntil(() => [...acks.keys()].filter((k) => k.startsWith('h')).length >= 8, 4_000, 'acks (laser)');
    expect([...acks].filter(([id, rej]) => id.startsWith('h') && !rej), 'the S laser leaves an AA-tier piece to the tractors').toEqual([]);
    expect(int().wreckIntegrity(piece.id)).toBe(integrity0);

    // The S tractor on the same piece: its fire is taken, a beam lease pulls it.
    let leased = false;
    for (let i = 0; i < 6; i++) {
      client.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: `t${i}`, weapon: 'hitscan', dirAngle: 0, slotId: 'aft' });
      await new Promise((r) => setTimeout(r, 120));
      leased ||= int().forceFields.tractorCount > 0;
    }
    await waitUntil(() => [...acks].some(([id, rej]) => id.startsWith('t') && !rej), 4_000, 'the tractor fires at the piece');
    expect(leased, 'a tractor lease on it').toBe(true);
  }, 40_000);
});
