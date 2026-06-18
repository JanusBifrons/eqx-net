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

  it('drives the wave lifecycle dispatch → attacking → stand-down (base destroyed) → enemies clear', async () => {
    clearAuditRing();
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span'],
      botCount: 8,
      seed: 9,
      bases: [
        {
          sector: 'emerald-span',
          owner: OFFLINE_OWNER,
          structures: [
            { kind: 'capital', x: 0, y: 0 },
            { kind: 'solar', x: 250, y: 0 },
            { kind: 'miner', x: -350, y: 0 },
            { kind: 'turret', x: 0, y: 350 },
          ],
        },
      ],
      director: { dispatchIntervalMs: 1, controlIntervalMs: 50, spoolMs: 40, hopTravelMs: 40 },
    });

    const room = h.getRoom('emerald-span') as unknown as {
      _internals: {
        structureRegistry: { all(): Iterable<{ id: string }> };
        applyDamage(targetId: string, shooterId: string, damage: number): void;
      };
      factionBaseReadiness(): Array<{ factionId: string; underWave: boolean }>;
    };

    // Dispatch → traverse → attack (the states only mock-tested in SquadBehaviour).
    await h.waitUntil(
      () => h!.director.squadSnapshot().byState.attacking > 0,
      8000,
      'squad reached attacking',
    );
    expect(getRecentAudit().some((e) => e.event === 'wave_dispatched')).toBe(true);

    // A4 — the REAL hostility side-effect fires: the real factionBaseReadiness()
    // reports the faction `underWave` (not a mocked room). This is the seam the
    // WaveDirector unit test can only fake.
    await h.waitUntil(
      () => room.factionBaseReadiness().find((r) => r.factionId === OFFLINE_OWNER)?.underWave === true,
      8000,
      'the real faction ledger flips underWave',
    );

    // Destroy the entire base → the faction is no longer a live target → the
    // squad stands down (factionStillHostile=false; no peaceful-timeout needed).
    for (const s of [...room._internals.structureRegistry.all()]) {
      room._internals.applyDamage(s.id, 'test-killer', 999_999);
    }

    // The squad drops its target and stands down (no longer warping/attacking).
    await h.waitUntil(
      () => {
        const b = h!.director.squadSnapshot().byState;
        return b.attacking === 0 && b.warping === 0;
      },
      8000,
      'squad stood down after the base was destroyed',
    );
    // …and the galaxy snapshot clears the hostiles (target cleared ⇒ neutral).
    await h.waitUntil(
      () => (h!.director.galaxySnapshot().find((s) => s.key === 'emerald-span')?.enemies ?? 0) === 0,
      8000,
      'enemies cleared from the galaxy snapshot after stand-down',
    );
  }, 30_000);

  it('time-boxed wave RESOLVES then RE-DISPATCHES a fresh wave (Phase-1 issue 4)', async () => {
    // The 12 h playtest audit showed waves NEVER resolved (wave_repelled=0) and
    // each base got exactly ONE wave forever — a perpetual grind, no phased
    // assaults. The time-box makes a wave fall back after waveMaxAttackMs (even
    // with the base intact + miners alive), freeing the faction so the dispatch
    // cadence sends a FRESH wave. This proves both halves end-to-end: a wave
    // RESOLVES (wave_repelled) AND a SECOND wave dispatches (≥2 wave_dispatched).
    clearAuditRing();
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span'],
      botCount: 8,
      seed: 5,
      bases: [
        {
          sector: 'emerald-span',
          owner: OFFLINE_OWNER,
          structures: [
            { kind: 'capital', x: 0, y: 0 },
            { kind: 'solar', x: 250, y: 0 },
            { kind: 'miner', x: -350, y: 0 }, // miner ALIVE the whole test ⇒ de-escalation can't fire
            { kind: 'turret', x: 0, y: 350 },
          ],
        },
      ],
      // Fast cycle: short attack window + immediate re-dispatch so the phase
      // boundary + the fresh wave both land inside the test budget.
      director: { dispatchIntervalMs: 1, controlIntervalMs: 50, spoolMs: 40, hopTravelMs: 40, waveMaxAttackMs: 400 },
    });

    // The first wave engages.
    await h.waitUntil(
      () => h!.director.squadSnapshot().byState.attacking > 0,
      8000,
      'first wave reaches attacking',
    );
    // It falls back after the time-box (resolves) even though the base + miner stand.
    await h.waitUntil(
      () => getRecentAudit().some((e) => e.event === 'wave_repelled'),
      8000,
      'the wave time-boxes out and falls back (resolves)',
    );
    // A FRESH wave re-dispatches — the "one squad forever" lock is gone.
    await h.waitUntil(
      () => getRecentAudit().filter((e) => e.event === 'wave_dispatched').length >= 2,
      10000,
      'a fresh wave re-dispatches after the phase ends',
    );
  }, 30_000);
});
