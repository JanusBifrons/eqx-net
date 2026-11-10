/**
 * exp/fire-control P2 — target locking through the REAL room.
 *
 * Lock-to-fire is universal: every pilot may only fire a weapon group at a
 * LOCKED target. Locking a non-hostile target (here another player) runs the
 * failsafe ring first; finishing it is logged as a hostile act; then the
 * lock acquires, the snapshot reports it LOCKED, and fire is accepted.
 * A pilot who never locks is refused (no legacy pass-through any more).
 *
 * Deterministic poses: both ships spawn at fixed points (angle 0).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

interface Ack { clientShotId: string; rejected?: boolean }
interface SnapGroups { id: string; m: number; l: Array<{ t: string; s: number; p: number }> }

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — fire-control target locks', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('no lock ⇒ fire refused; failsafe → hostile act → locked ⇒ fire accepted', async () => {
    const shooterPid = randomUUID();
    const targetPid = randomUUID();
    const shooter = (await harness.connectActive(shooterPid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0,
    })) as ClientRoom<SectorState>;
    await harness.connectActive(targetPid, { spawnX: 0, spawnY: 180 });

    const acks: Ack[] = [];
    shooter.onMessage('hit_ack', (m: Ack) => acks.push(m));
    let groups: SnapGroups[] | undefined;
    shooter.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const s of Object.values(snap.states ?? {})) if (s.playerId === shooterPid) groups = s.groups;
    });
    const fire = (id: string): void => {
      const tick = (harness.getServerRoom() as unknown as SectorRoom)._internals.serverTick;
      shooter.send('fire', { type: 'fire', tick, clientShotId: id, weapon: 'hitscan', dirAngle: 0, slotId: 'primary' });
    };

    await harness.advance(300);
    // 1) No lock yet → refused.
    fire('before');
    await waitUntil(() => acks.some((a) => a.clientShotId === 'before'), 3000, 'ack before');
    expect(acks.find((a) => a.clientShotId === 'before')?.rejected).toBe(true);

    // 2) Lock the other player: neutral ⇒ failsafe, then a logged hostile act.
    shooter.send('lock_request', { type: 'lock_request', groupId: 'primary', target: `p:${targetPid}` });
    await waitUntil(() => (groups?.[0]?.l.length ?? 0) > 0, 3000, 'lock appears');
    expect(groups![0]!.l[0]!.s).toBe(0); // failsafe first
    await harness.events.waitFor({ tag: 'lock_hostile_act', where: (d) => d['playerId'] === shooterPid }, { timeoutMs: 12_000 });
    await waitUntil(() => groups?.[0]?.l[0]?.s === 2, 12_000, 'locked');

    // 3) Locked → fire accepted (hit or miss, never rejected).
    fire('after');
    await waitUntil(() => acks.some((a) => a.clientShotId === 'after'), 3000, 'ack after');
    expect(acks.find((a) => a.clientShotId === 'after')?.rejected).not.toBe(true);
  }, 30_000);

  it('lock-to-fire is universal: a pilot who joined with no options cannot fire without a lock', async () => {
    const pid = randomUUID();
    const room = (await harness.connectActive(pid, { shipKind: 'interceptor', spawnX: 0, spawnY: 0 })) as ClientRoom<SectorState>;
    const acks: Ack[] = [];
    room.onMessage('hit_ack', (m: Ack) => acks.push(m));
    await harness.advance(300);
    const tick = (harness.getServerRoom() as unknown as SectorRoom)._internals.serverTick;
    room.send('fire', { type: 'fire', tick, clientShotId: 'legacy', weapon: 'hitscan', dirAngle: 0, slotId: 'primary' });
    await waitUntil(() => acks.some((a) => a.clientShotId === 'legacy'), 3000, 'legacy ack');
    expect(acks.find((a) => a.clientShotId === 'legacy')?.rejected).toBe(true);
  }, 15_000);
});

describe('SectorRoom integration — fire-control AUTO groups', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true,
      dronePoses: [{ kind: 'fighter', x: 0, y: 150, angle: 0, hullExposed: true }],
    });
  }, 15_000);
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('an idle AUTO group locks a drone hostile to the pilot on its own', async () => {
    const pid = randomUUID();
    const room = (await harness.connectActive(pid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, startHostile: true,
    })) as ClientRoom<SectorState>;
    let groups: SnapGroups[] | undefined;
    room.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pid) groups = st.groups;
    });
    await waitUntil(() => groups?.[0]?.l[0]?.s === 2, 10_000, 'auto locked');
    expect(groups![0]!.m).toBe(0);
  }, 20_000);

  it('testMode groupMode=manual: every group starts in MAN and never self-picks, even with instantLock', async () => {
    const pid = randomUUID();
    const room = (await harness.connectActive(pid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, startHostile: true, instantLock: true, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    let groups: SnapGroups[] | undefined;
    let snaps = 0;
    room.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pid && st.groups) { groups = st.groups; snaps++; }
    });
    // instantLock would lock the hostile drone 150 u ahead within ~100 ms on AUTO.
    await waitUntil(() => snaps >= 10, 5_000, '10 snapshots with groups');
    expect(groups!.length).toBeGreaterThan(0);
    for (const g of groups!) {
      expect(g.m).toBe(1);
      expect(g.l).toEqual([]);
    }
    // Switching a group to AUTO afterwards locks as usual.
    room.send('set_group_mode', { type: 'set_group_mode', groupId: groups![0]!.id, mode: 'auto' });
    await waitUntil(() => groups?.[0]?.l[0]?.s === 2, 3_000, 'auto locked after switch');
  }, 20_000);
});
