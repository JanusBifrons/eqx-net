/**
 * Living Galaxy Phase 3 — locks the REAL SectorRoom.liveCounts() the
 * LivingWorldDirector aggregates for GET /galaxy/snapshot: present players, the
 * drone enemy/neutral split (a drone is an "enemy" iff it is hostile to a present
 * active player), and the placed-structure count. The director-side aggregation
 * + the /snapshot null-guard are unit-locked separately
 * (LivingWorldDirector.galaxySnapshot.test.ts + galaxyStatsProvider.test.ts);
 * this is the room-side counting lock.
 *
 * playerIds are randomUUID() per test — a fixed id can collide with a roster row
 * persisted by an earlier run in the worktree's eqx.db, sending the join down a
 * ship-restore path that never activates (the connectActive 3 s timeout).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

interface LiveCounts {
  players: number;
  enemies: number;
  neutrals: number;
  structures: number;
}
const liveCountsOf = (h: SectorTestHarness): LiveCounts =>
  (h.getServerRoom() as unknown as { liveCounts(): LiveCounts }).liveCounts();

interface DroneInternals {
  spawnTestDrone: (id: string, x: number, y: number) => boolean;
  applyDamage: (targetId: string, shooterId: string, damage: number) => void;
}
const internalsOf = (h: SectorTestHarness): DroneInternals =>
  (h.getServerRoom() as unknown as { _internals: DroneInternals })._internals;

describe('SectorRoom integration — liveCounts (Living Galaxy Phase 3)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('counts present players and the drone enemy/neutral split by hostility', async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
    const pid = randomUUID();
    await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const internals = internalsOf(harness);
    expect(internals.spawnTestDrone('lc-drone-1', 0, -550)).toBe(true);

    // A freshly-spawned drone is hostile to nobody → neutral.
    let counts = liveCountsOf(harness);
    expect(counts.players).toBe(1);
    expect(counts.structures).toBe(0);
    expect(counts.neutrals).toBe(1);
    expect(counts.enemies).toBe(0);

    // The player shoots the drone → the drone becomes hostile to the player → enemy.
    internals.applyDamage('lc-drone-1', pid, 5);
    counts = liveCountsOf(harness);
    expect(counts.enemies).toBe(1);
    expect(counts.neutrals).toBe(0);
  }, 20_000);

  it('counts placed structures and a drone with no present player as neutral', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      testMode: true,
      asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 150, y: 60 },
        { kind: 'solar', x: 250, y: 0 },
      ],
      scenarioDrones: [{ x: 0, y: -550 }],
    });
    // connectAs is a pending (inactive) hull — enough to read structures/drones;
    // no active player means the scenario drone is hostile to nobody present.
    await harness.connectAs(randomUUID());
    const counts = liveCountsOf(harness);
    expect(counts.structures).toBe(3);
    expect(counts.neutrals).toBe(1);
    expect(counts.enemies).toBe(0);
    expect(counts.players).toBe(0);
  }, 20_000);
});
