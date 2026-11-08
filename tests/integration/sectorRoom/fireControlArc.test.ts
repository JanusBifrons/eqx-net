/**
 * exp/fire-control — a group never fires at a target outside its mounts' arc.
 *
 * User report (2026-11-08, from the fc-duel footage): "Why does the weapon
 * fire the moment it spawns in, despite the target being outside of the
 * arc?" The gunship's Aft group (a rear turret, ±90° about the tail) locked
 * the ships dead AHEAD — AUTO picked the nearest hostile with no arc check —
 * and then fired: the turret parked at its arc limit, so the bolts streamed
 * out of the ship's SIDE. The client only arc-checked all-fixed groups and
 * the server only checked that a lock existed.
 *
 * Repro: gunship (Fore = forward turret ±45°, Aft = rear turret ±90°) facing
 * +y, a hostile drone straight ahead. Fore's shots are accepted; Aft's are
 * refused (`hit_ack.rejected`) — the gunship fires bolts, so the ack is the
 * observable, not `laser_fired` (beams only).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

interface SnapGroups { id: string; m: number; l: Array<{ t: string; s: number; p: number }> }

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — fire control respects mount arcs', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true,
      dronePoses: [{ kind: 'heavy', x: 0, y: 260, angle: Math.PI }],
    });
  }, 15_000);
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('the rear group does not fire at a target dead ahead (outside its arc)', async () => {
    const pid = randomUUID();
    const room = (await harness.connectActive(pid, {
      shipKind: 'gunship', spawnX: 0, spawnY: 0, fireControl: true, startHostile: true, initialHull: 100_000,
    })) as ClientRoom<SectorState>;
    const acks = new Map<string, boolean>(); // clientShotId → rejected
    room.onMessage('hit_ack', (m: { clientShotId: string; rejected?: boolean }) => acks.set(m.clientShotId, m.rejected === true));
    let groups: SnapGroups[] | undefined;
    room.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; groups?: SnapGroups[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pid) groups = st.groups;
    });
    const fire = (slotId: string, id: string): void => {
      const tick = (harness.getServerRoom() as unknown as SectorRoom)._internals.serverTick;
      room.send('fire', { type: 'fire', tick, clientShotId: id, weapon: 'laser', dirAngle: 0, slotId });
    };
    // Fore must be able to lock the drone ahead (positive control).
    await waitUntil(() => groups?.find((g) => g.id === 'fore')?.l.some((l) => l.s === 2) === true, 12_000, 'fore locked');
    // Ask BOTH groups to fire for a while, as the client's AUTO loop would.
    for (let i = 0; i < 12; i++) {
      fire('fore', `f${i}`);
      fire('aft', `a${i}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    await waitUntil(() => acks.size >= 20, 4_000, 'acks');
    const accepted = (prefix: string): number => [...acks].filter(([id, rej]) => id.startsWith(prefix) && !rej).length;
    expect(accepted('f')).toBeGreaterThan(0); // Fore bears on it
    expect(accepted('a')).toBe(0); // Aft can't: it must not fire out of its arc
  }, 30_000);
});
