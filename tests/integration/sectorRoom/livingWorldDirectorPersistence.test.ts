/**
 * Phase-5 integration lock for director-state persistence ("restart from any
 * state"). The LivingWorldDirector must survive a server restart and RESUME its
 * squads where they were — not re-seed from scratch.
 *
 * Faithful-restart shape: two SEQUENTIAL boots of a real multi-room galaxy that
 * SHARE one injected `DirectorPersistence` (an in-memory captured row). Boot #1
 * lets a squad ROAM into the interior `sol-prime`, then persists. Boot #2 brings
 * up FRESH rooms + a FRESH director with roaming DISABLED — so the ONLY way a
 * squad's goal can be the interior `sol-prime` (a non-entry sector a fresh seed
 * never homes at, and roaming-off never drifts to) is the restored state. The
 * bots converging on `sol-prime` after the restart is therefore proof the
 * director picked up where it left off.
 *
 * (The serialize/restore units are covered by DirectorPersistence.test.ts +
 * SquadPool/WaveDirector.test.ts; this is the end-to-end wiring lock.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import {
  DirectorPersistence,
  type DirectorStatePayload,
} from '../../../src/server/livingworld/DirectorPersistence.js';
import { isEntrySector } from '../../../src/core/galaxy/galaxy.js';

const noopLogger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

describe('LivingWorldDirector — state persistence across a restart (Phase 5)', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('resumes a squad at its persisted (roamed-into-interior) sector after a restart', async () => {
    // Shared persistence row across the two boots (the only thing that survives a
    // "restart" — the rooms + director are rebuilt fresh).
    let row: { payload_json: string; created_at: number } | undefined;
    const dp = new DirectorPersistence({
      saveRow: (p) => {
        row = { payload_json: JSON.stringify(p), created_at: Date.now() };
      },
      loadRow: () => row,
      logger: noopLogger,
    });

    // ── Boot #1: a squad gathers at its home edge, then roams into the interior.
    h = await bootLivingWorldTestServer({
      sectors: ['orion-belt', 'sol-prime'],
      botCount: 8, // exactly one full squad
      seed: 11,
      directorPersistence: dp,
      director: { roamIntervalMs: 100, hopTravelMs: 40 },
    });
    await h.waitUntil(
      () => h!.director.snapshot().perSector['sol-prime']!.bots > 0,
      8000,
      'squad roamed into the interior (boot #1)',
    );
    // Persist the live state, then assert the row captured the interior goal.
    h.director.persistState();
    expect(row).toBeDefined();
    const saved = JSON.parse(row!.payload_json) as DirectorStatePayload;
    expect(saved.squads.some((s) => s.sectorKey === 'sol-prime')).toBe(true);

    await h.cleanup();
    h = undefined;

    // ── Boot #2: FRESH rooms + director, roaming DISABLED. A fresh seed homes
    //    squads at the entry edge and (roaming off) never drifts inward — so the
    //    squad's goal can only be the interior `sol-prime` via RESTORE.
    h = await bootLivingWorldTestServer({
      sectors: ['orion-belt', 'sol-prime'],
      botCount: 8,
      seed: 11,
      directorPersistence: dp,
      director: { roamIntervalMs: 600_000, hopTravelMs: 40, respawnDelayMs: 50 },
    });
    await h.waitUntil(
      () => h!.director.snapshot().perSector['sol-prime']!.bots > 0,
      8000,
      'restored squad resumes its goal at sol-prime (boot #2)',
    );

    // Ingress invariant survives the restart: every from-nowhere spawn is still
    // at an entry edge (the restored bots warp in at the edge and traverse in).
    for (const e of h.events.all({ tag: 'bot_spawn' })) {
      expect(isEntrySector(e.data['sectorKey'] as string)).toBe(true);
    }
  }, 45_000);

  it('a fresh director with no persisted row falls back to a clean seed (no resume)', async () => {
    // The null-hydrate path: an empty DirectorPersistence must NOT change today's
    // behaviour — squads home at the entry edge, none ingress the interior.
    let row: { payload_json: string; created_at: number } | undefined;
    const dp = new DirectorPersistence({
      saveRow: (p) => {
        row = { payload_json: JSON.stringify(p), created_at: Date.now() };
      },
      loadRow: () => row, // starts undefined ⇒ hydrate() → null ⇒ fresh seed
      logger: noopLogger,
    });

    h = await bootLivingWorldTestServer({
      sectors: ['orion-belt', 'sol-prime'],
      botCount: 8,
      seed: 11,
      directorPersistence: dp,
      director: { roamIntervalMs: 600_000, hopTravelMs: 40 },
    });
    await h.waitUntil(
      () => h!.director.snapshot().perSector['orion-belt']!.bots === 8,
      8000,
      'squad gathered at its home edge',
    );
    // Roaming off + no restore + no base ⇒ the interior stays empty.
    await h.advance(400);
    expect(h.director.snapshot().perSector['sol-prime']!.bots).toBe(0);
  }, 30_000);
});
