/**
 * "Locks keep it hostile" (owner decision 2026-11-10).
 *
 * Symptom (showcase clip, real-scale long guns): the enemy battleship dropped
 * its lock on the player at 29 s and never fired again while the player kept
 * firing. A 16" shell flies ~30 s, so no hit landed inside the 30 s
 * hit-makes-hostile decay (`FORGET_TICKS`, 1800 ticks) and the NPC forgot the
 * pilot between salvos, even though the pilot held a lock on it throughout.
 *
 * Rule: an NPC stays hostile to a pilot while any of that pilot's weapon
 * groups is LOCKING or LOCKED onto it, and for the usual 30 s after the lock
 * drops. Being targeted is a hostile act.
 *
 * Game time: the room clock can't be fast-forwarded (`testTimeScale` scales
 * the physics step, not the tick count), so the test AGES the ledger instead:
 * it re-marks the last hostile act 1790 ticks (29.8 s) in the past, then lets
 * ~1 s of ticks run. Without a lock refresh that crosses the 30 s window and
 * the NPC forgets; with one, the lock stamps it current again. Doing that
 * three times under one held lock is >60 s of no-hit game time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

interface LockedBy { t: string; s: number; p: number }
interface SnapGroups { id: string; l: Array<{ t: string; s: number }> }
interface RoomPeek {
  npcHostileTo(id: string, pid: string): boolean;
  aiController: { markHostile(id: string, pid: string, tick: number): void };
}

/** Just inside the 30 s (1800-tick) hostility window. */
const AGE_TICKS = 1790;

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!predicate()) throw new Error(`waitUntil timed out: ${label}`);
}

describe('SectorRoom integration — a pilot\'s lock keeps the NPC hostile', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true,
      dronePoses: [{ kind: 'fighter', x: 0, y: 160, angle: Math.PI }],
    });
  }, 15_000);
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a held lock with no hits keeps it hostile and locking; after cancel it forgets 30 s later', async () => {
    const pid = randomUUID();
    const room = (await harness.connectActive(pid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, startHostile: true, initialHull: 1_000_000_000,
      groupMode: 'manual', // no AUTO re-lock after the cancel below
    })) as ClientRoom<SectorState>;
    const server = harness.getServerRoom() as unknown as SectorRoom;
    const peek = server as unknown as RoomPeek;
    const tick = (): number => server._internals.serverTick;
    const drone = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1)!;
    expect(drone).toBeDefined();
    const hostile = (): boolean => peek.npcHostileTo(drone.id, pid);
    /** Pretend the last hostile act was 29.8 s ago, then let ~1 s of ticks pass. */
    const ageAndWait = async (): Promise<void> => {
      peek.aiController.markHostile(drone.id, pid, tick() - AGE_TICKS);
      const t0 = tick();
      await waitUntil(() => tick() - t0 >= 60, 5000, '1 s of ticks');
    };

    let lockedBy: LockedBy[] | undefined;
    let groups: SnapGroups[] | undefined;
    room.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; lockedBy?: LockedBy[]; groups?: SnapGroups[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) {
        if (st.playerId !== pid) continue;
        lockedBy = st.lockedBy;
        groups = st.groups;
      }
    });

    expect(hostile()).toBe(true);
    harness.lockTarget(pid, drone.id);
    // Never fire: hostility must come from the held lock alone.
    for (let i = 0; i < 3; i++) {
      await ageAndWait();
      expect(hostile(), `still hostile under lock (round ${i + 1})`).toBe(true);
    }
    // ...and the NPC still has (or is building) its own lock on the pilot.
    await waitUntil(() => lockedBy?.some((l) => l.t.startsWith('s:') && l.s >= 1) === true, 5000, 'NPC locks the pilot');

    // Cancel every group's lock: no more refresh.
    await waitUntil(() => (groups?.length ?? 0) > 0, 3000, 'own-ship groups on the snapshot');
    for (const g of groups!) room.send('lock_cancel', { type: 'lock_cancel', groupId: g.id });
    await waitUntil(() => groups!.every((g) => g.l.length === 0), 3000, 'locks cancelled');
    // Inside the usual 30 s window it stays hostile...
    const cancelledAt = tick();
    await waitUntil(() => tick() - cancelledAt >= 60, 5000, '1 s after cancel');
    expect(hostile()).toBe(true);
    // ...and once 30 s have passed since the last hostile act, it forgets.
    await ageAndWait();
    expect(hostile()).toBe(false);
  }, 40_000);
});
