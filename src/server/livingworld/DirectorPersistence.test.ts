/**
 * Phase-5 director-state persistence ("restart from any state") round-trip lock.
 *
 * The LivingWorldDirector must survive a server restart and resume its squads
 * instead of re-seeding from scratch. This drives the persist→hydrate round-trip
 * over injected `saveRow`/`loadRow` fakes (no real sqlite worker) and asserts:
 *   - a written payload hydrates back deep-equal;
 *   - a version mismatch, a stale row, a corrupt row, and a missing row each
 *     yield `null` so the director falls through to its fresh seed.
 */
import { describe, it, expect } from 'vitest';
import type { Logger } from 'pino';
import {
  DirectorPersistence,
  DIRECTOR_STATE_VERSION,
  DIRECTOR_STATE_STALENESS_MS,
  parseDirectorState,
  type DirectorStatePayload,
} from './DirectorPersistence.js';

const noopLogger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

function makePayload(over: Partial<DirectorStatePayload> = {}): DirectorStatePayload {
  return {
    version: DIRECTOR_STATE_VERSION,
    savedAtMs: 1_700_000_000_000,
    squads: [
      { squadId: 'squad-0', kind: 'fighter', sectorKey: 'galaxy-1-0', targetFactionId: null, state: 'idle' },
      {
        squadId: 'squad-1',
        kind: 'fighter',
        sectorKey: 'galaxy-0-0',
        targetFactionId: 'faction-bob',
        state: 'attacking',
      },
      { squadId: 'squad-2', kind: 'fighter', sectorKey: 'galaxy-2--1', targetFactionId: null, state: 'warping' },
    ],
    waveCount: [['faction-bob', 3]],
    lastDispatchAtMs: [['faction-bob', 1_699_999_990_000]],
    ...over,
  };
}

/** A capturing sink: `saveRow` stamps `created_at` with a controllable clock so
 *  the staleness branch is testable. */
function makeDeps(createdAtMs: number = Date.now()) {
  let stored: { payload_json: string; created_at: number } | undefined;
  return {
    getStored: () => stored,
    setRaw: (payload_json: string, created_at: number) => {
      stored = { payload_json, created_at };
    },
    deps: {
      saveRow: (payload: DirectorStatePayload) => {
        stored = { payload_json: JSON.stringify(payload), created_at: createdAtMs };
      },
      loadRow: () => stored,
      logger: noopLogger,
    },
  };
}

describe('DirectorPersistence', () => {
  it('round-trips a payload through persist → hydrate', () => {
    const { deps } = makeDeps();
    const dp = new DirectorPersistence(deps);
    const payload = makePayload();
    dp.persist(payload);
    const restored = dp.hydrate();
    expect(restored).toEqual(payload);
  });

  it('returns null when there is no prior row (fresh seed)', () => {
    const { deps } = makeDeps();
    const dp = new DirectorPersistence(deps);
    expect(dp.hydrate()).toBeNull();
  });

  it('discards a version-mismatched row (fresh seed)', () => {
    const { deps, setRaw } = makeDeps();
    const dp = new DirectorPersistence(deps);
    setRaw(JSON.stringify(makePayload({ version: DIRECTOR_STATE_VERSION + 1 })), Date.now());
    expect(dp.hydrate()).toBeNull();
  });

  it('discards a stale row beyond the staleness window (fresh seed)', () => {
    const staleCreatedAt = Date.now() - DIRECTOR_STATE_STALENESS_MS - 60_000;
    const { deps } = makeDeps(staleCreatedAt);
    const dp = new DirectorPersistence(deps);
    dp.persist(makePayload());
    expect(dp.hydrate()).toBeNull();
  });

  it('discards a corrupt (non-JSON) row (fresh seed)', () => {
    const { deps, setRaw } = makeDeps();
    const dp = new DirectorPersistence(deps);
    setRaw('{ not valid json', Date.now());
    expect(dp.hydrate()).toBeNull();
  });

  it('swallows a saveRow throw (best-effort crash defence)', () => {
    const dp = new DirectorPersistence({
      saveRow: () => {
        throw new Error('worker down');
      },
      loadRow: () => undefined,
      logger: noopLogger,
    });
    expect(() => dp.persist(makePayload())).not.toThrow();
  });

  it('parseDirectorState throws on a missing/invalid version', () => {
    expect(() => parseDirectorState({ squads: [] })).toThrow();
    expect(() => parseDirectorState(null)).toThrow();
  });
});
