/**
 * Equinox Phase 9 (item 5) — locks the REAL SectorRoom recent-combat wiring the
 * LivingWorldDirector forwards into GET /galaxy/snapshot: a confirmed combat
 * death (here a drone) is tallied as a recent SHIP destruction, surfaced by
 * SectorRoom.recentCombat(). The sliding-window logic + the director aggregation
 * are unit-locked separately (RecentCombatLog.test.ts +
 * LivingWorldDirector.galaxySnapshot.test.ts); this is the room-side hook lock —
 * the level where "did I increment at the right destruction hook?" lives.
 *
 * playerIds are randomUUID() per test (avoids a roster-row collision from an
 * earlier run in the worktree's eqx.db — the galaxyLiveCounts.test.ts caveat).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

interface RecentCombat {
  shipsDestroyed: number;
  structuresDestroyed: number;
  lastEventMs: number;
}
interface DroneInternals {
  spawnTestDrone: (id: string, x: number, y: number) => boolean;
  applyDamage: (targetId: string, shooterId: string, damage: number) => void;
}
const internalsOf = (h: SectorTestHarness): DroneInternals =>
  (h.getServerRoom() as unknown as { _internals: DroneInternals })._internals;
const recentCombatOf = (h: SectorTestHarness): RecentCombat | null =>
  (h.getServerRoom() as unknown as { recentCombat(): RecentCombat | null }).recentCombat();

describe('SectorRoom integration — recentCombat (Equinox Phase 9 item 5)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('records a drone kill as a recent SHIP destruction', async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
    // A pending hull keeps the room live while we drive the kill (mirrors
    // galaxyLiveCounts.test.ts); recentCombat() itself needs no present player.
    await harness.connectAs(randomUUID());
    const internals = internalsOf(harness);
    expect(internals.spawnTestDrone('rc-drone-1', 0, -550)).toBe(true);

    // Quiet before any destruction.
    expect(recentCombatOf(harness)).toBeNull();

    // Kill the drone — drop the shield then the hull (no-spillover ⇒ a few hits).
    const shooter = randomUUID();
    for (let i = 0; i < 4; i++) internals.applyDamage('rc-drone-1', shooter, 100_000);

    // Death routes through evictSwarmEntity → auditCombatDestruction synchronously,
    // but poll briefly in case any step defers to a microtask.
    let rc: RecentCombat | null = null;
    for (let i = 0; i < 20; i++) {
      rc = recentCombatOf(harness);
      if (rc) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(rc, 'a drone kill should register recent combat').not.toBeNull();
    expect(rc!.shipsDestroyed).toBeGreaterThanOrEqual(1);
    expect(rc!.structuresDestroyed).toBe(0);
    expect(rc!.lastEventMs).toBeGreaterThan(0);
  }, 20_000);
});
