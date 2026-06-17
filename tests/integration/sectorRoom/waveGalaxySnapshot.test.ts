/**
 * Integration regression lock for the galaxy-map "no hostile ships" bug
 * (PR #92 / fix(galaxy-map): show dispatched waves as hostile regardless of
 * player presence).
 *
 * THE bug class (root CLAUDE.md invariant #13 — test at the level the bug
 * lives): the galaxy map showed zero hostiles while a wave razed an OFFLINE
 * base, because `SectorRoom.liveCounts` classified a drone as an "enemy" only
 * relative to a PRESENT player. The unit test (LivingWorldDirector.galaxy-
 * Snapshot.test.ts, MOCK rooms) was green; nothing drove a REAL wave through
 * dispatch → traverse → attack and asserted the snapshot. This does.
 *
 * It drives a real multi-sector wave against a real, ready, OFFLINE-owned base
 * and asserts `director.galaxySnapshot()` shows `enemies > 0` in the base
 * sector with `players: 0`. Reverting PR #92's `recomputeGalaxyStats` change
 * (squad-faction-derived enemies) makes the wait time out — the regression lock.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { getRecentAudit, clearAuditRing } from '../../../src/server/audit/GameplayAuditLog.js';

const OFFLINE_OWNER = 'offline-owner';

describe('SectorRoom integration — a wave shows as hostile on the galaxy snapshot (offline owner)', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('a wave dispatched at an OFFLINE ready base shows enemies>0 (players:0) in the galaxy snapshot', async () => {
    clearAuditRing();
    h = await bootLivingWorldTestServer({
      // greenfall is the only galaxy ENTRY sector here (the squad homes there);
      // emerald-span is its interior neighbour where the base lives.
      sectors: ['greenfall', 'emerald-span'],
      botCount: 8, // one full squad (squad-0)
      seed: 5,
      bases: [
        {
          sector: 'emerald-span',
          owner: OFFLINE_OWNER,
          // A READY base (isBaseReady: Capital + ≥1 Miner + ≥1 Solar + ≥1
          // Turret), seeded PRE-BUILT (isConstructed) + non-overlapping.
          structures: [
            { kind: 'capital', x: 0, y: 0 },
            { kind: 'solar', x: 250, y: 0 },
            { kind: 'miner', x: -350, y: 0 },
            { kind: 'turret', x: 0, y: 350 },
          ],
        },
      ],
      // Fast wave: immediate dispatch (no rate cap) + short spool/hop so the
      // squad warps greenfall→emerald-span and attacks within the test window.
      director: { dispatchIntervalMs: 1, controlIntervalMs: 50, spoolMs: 40, hopTravelMs: 40 },
    });

    // NO player connects — the base owner is OFFLINE. Equinox: a ready base
    // draws a wave regardless of presence, and the map MUST reflect it.
    await h.waitUntil(
      () => (h!.director.galaxySnapshot().find((s) => s.key === 'emerald-span')?.enemies ?? 0) > 0,
      8000,
      'the offline base sector shows hostile ships on the galaxy snapshot',
    );

    const target = h.director.galaxySnapshot().find((s) => s.key === 'emerald-span')!;
    expect(target.players).toBe(0); // owner is offline — nobody present
    expect(target.enemies).toBeGreaterThan(0); // …yet the wave is visibly hostile

    // The wave was actually dispatched at this faction (audit end-to-end lock).
    const dispatched = getRecentAudit().filter((e) => e.event === 'wave_dispatched');
    expect(dispatched.some((e) => (e as { owner?: string }).owner === OFFLINE_OWNER)).toBe(true);
  }, 25_000);
});
