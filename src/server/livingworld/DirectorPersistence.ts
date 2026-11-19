/**
 * Persist + hydrate the process-global `LivingWorldDirector`'s ABSTRACT squad
 * continuity across a server restart (Phase 5 — "restart from any state").
 *
 * The director owns the hunter-bot squads (drones are NOT in the per-sector
 * snapshot; they're director-owned). Today the director re-seeds from scratch on
 * every boot — squads re-home at entry sectors, in-flight waves are forgotten.
 * This module shadows the SMALL, durable continuity (each squad's
 * `{sectorKey, targetFactionId, state}` + the WaveDirector's wave bookkeeping)
 * so a restart resumes the living world where it left off. The fixed bot pool is
 * always re-seeded; only squad ASSIGNMENTS persist, and bots re-spawn at their
 * squad's restored sector via the existing respawn path.
 *
 * Deliberately NOT persisted: individual bot poses and in-flight
 * `BotTransitController` warps (not trivially serializable) — a mid-flight hop
 * cleanly resets to the squad's sector on restart.
 *
 * Mirrors `SectorPersistence`: the DB read/write is INJECTED (`saveRow` /
 * `loadRow`) so the persist↔hydrate round-trip is unit-testable without the real
 * sqlite worker. A version mismatch / staleness / corrupt row ⇒ `null` (the
 * director falls through to its today's fresh seed). See
 * docs/architecture/persistence-and-migrations.md.
 */

import type { Logger } from 'pino';
import { z } from 'zod';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { canonicalPlayerId } from '../identity/AccountPlayerRegistry.js';

/**
 * Bump to discard every persisted director-state row and fall back to a clean
 * fresh seed (mirrors `CURRENT_SCHEMA_VERSION`'s tear-down-on-change knob). Bump
 * whenever the squad-count, squad-id scheme, or payload shape changes.
 */
export const DIRECTOR_STATE_VERSION = 1;

/** Maximum age of a hydrated director-state row before it's discarded (24 h). */
export const DIRECTOR_STATE_STALENESS_MS = 24 * 60 * 60 * 1000;

/**
 * The serializable per-squad continuity. `botIds` is NOT persisted (the pool is
 * re-seeded and re-derives membership); `warned` is a per-wave one-shot. The
 * `state` union mirrors `SquadState` in `director/SquadPool.ts` exactly — the
 * `SquadPool.serialize` map site fails to typecheck if they ever drift.
 */
export interface DirectorSquadState {
  squadId: string;
  kind: string;
  sectorKey: string;
  targetFactionId: string | null;
  state: 'forming' | 'idle' | 'warping' | 'attacking' | 'retreating';
}

export interface DirectorStatePayload {
  version: number;
  savedAtMs: number;
  squads: DirectorSquadState[];
  /** WaveDirector `waveCount` map as entry pairs. */
  waveCount: Array<[string, number]>;
  /** WaveDirector `lastDispatchAtMs` map as entry pairs. */
  lastDispatchAtMs: Array<[string, number]>;
  /** Step 1c — the control meter of each sector whose state differs from its
   *  static seed (robot director only; `RobotTerritory`). Absent in older rows
   *  and on the drone director: every sector then starts from its seed. */
  sectorControl?: PersistedSectorControl[];
}

/** One sector's saved control meter: the holder (null = neutral) and each
 *  side's share as `[factionId, share]` (0..100, rounded, tiny shares dropped). */
export interface PersistedSectorControl {
  sectorKey: string;
  holder: string | null;
  shares: Array<[string, number]>;
  /** Galaxy feed — when the holder last changed (game ms); absent = no flip saved. */
  flippedAtMs?: number;
  /** Galaxy feed — the last hour of control as `[atMs, holder, holderShare]`,
   *  oldest first, so the sector panel's graph survives a restart. */
  history?: Array<[number, string | null, number]>;
}

const PersistedSectorControlSchema = z.object({
  sectorKey: z.string().min(1),
  holder: z.string().min(1).nullable(),
  shares: z.array(z.tuple([z.string().min(1), z.number().finite().min(0).max(100)])),
  flippedAtMs: z.number().finite().optional(),
  history: z.array(z.tuple([z.number().finite(), z.string().min(1).nullable(), z.number().finite().min(0).max(100)])).max(120).optional(),
});

/** Parse-and-drop the saved control entries: a missing or non-array field is
 *  no entries (older rows), and a malformed entry is skipped, never thrown. */
export function parseSectorControl(raw: unknown): PersistedSectorControl[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedSectorControl[] = [];
  for (const e of raw) {
    const r = PersistedSectorControlSchema.safeParse(e);
    if (r.success) out.push(r.data);
  }
  return out;
}

export interface DirectorPersistenceDeps {
  /** Write the singleton director-state row (production: an `enqueueCritical`
   *  `DIRECTOR_STATE_PUT`). */
  saveRow: (payload: DirectorStatePayload) => void;
  /** Load the singleton director-state row (production: a sqlite SELECT on
   *  `director_state WHERE id = 1`). Returns undefined when there is none. */
  loadRow: () => { payload_json: string; created_at: number } | undefined;
  logger: Logger;
}

/**
 * Validate a parsed JSON object as a current-version director-state payload.
 * Returns it if valid; throws otherwise (caller catches → fresh seed).
 */
export function parseDirectorState(raw: unknown): DirectorStatePayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('parseDirectorState: not an object');
  }
  const obj = raw as Record<string, unknown>;
  const v = obj['version'];
  if (typeof v !== 'number') {
    throw new Error('parseDirectorState: missing version');
  }
  if (v !== DIRECTOR_STATE_VERSION) {
    throw new Error(
      `director-state version ${v} != current ${DIRECTOR_STATE_VERSION} — discard + fresh seed`,
    );
  }
  // Trust the squad/wave shape past this point — sole writer is this codebase.
  // Control entries are checked one by one (a bad one is dropped, not fatal).
  const payload = obj as unknown as DirectorStatePayload;
  if (obj['sectorControl'] !== undefined) payload.sectorControl = parseSectorControl(obj['sectorControl']);
  return payload;
}

export class DirectorPersistence {
  constructor(private readonly deps: DirectorPersistenceDeps) {}

  /** Shadow the director's abstract continuity. Swallows enqueue failures
   *  (best-effort crash defence, like `SectorPersistence.persist`). */
  persist(payload: DirectorStatePayload): void {
    try {
      this.deps.saveRow(payload);
    } catch (err) {
      this.deps.logger.warn({ err }, 'director-state enqueue failed');
    }
  }

  /**
   * Read the singleton director-state row. Returns the payload, or `null` when
   * there is no row / it's stale / it fails version+shape validation — in every
   * `null` case the director falls through to its fresh seed.
   */
  hydrate(): DirectorStatePayload | null {
    let row: { payload_json: string; created_at: number } | undefined;
    try {
      row = this.deps.loadRow();
    } catch (err) {
      this.deps.logger.warn({ err }, 'director-state hydrate query failed — fresh seed');
      return null;
    }
    if (!row) {
      this.deps.logger.info({}, 'no prior director-state — fresh seed');
      return null;
    }
    const ageMs = Date.now() - row.created_at;
    if (ageMs > DIRECTOR_STATE_STALENESS_MS) {
      this.deps.logger.info({ ageMs }, 'director-state stale — fresh seed');
      return null;
    }
    try {
      const payload = parseDirectorState(JSON.parse(row.payload_json));
      this.deps.logger.info({ ageMs, squads: payload.squads.length }, 'director-state hydrated');
      return payload;
    } catch (err) {
      this.deps.logger.warn({ err }, 'director-state parse/version mismatch — fresh seed');
      return null;
    }
  }
}

/** Throttle (ms) for the director's crash-defence state persist inside the
 *  control loop — matches the 60 s sector-snapshot cadence. The PRIMARY persist
 *  is on graceful shutdown (index.ts); this bounds loss if the process is killed
 *  uncleanly. It's a CRITICAL enqueue from the 1.5 s control loop, NOT the 60 Hz
 *  `update()`, so it stays off the live loop. */
export const DIRECTOR_PERSIST_INTERVAL_MS = 60_000;

/** The director parts a save/restore reads and writes (built once by the
 *  director; structural so this module never imports the director's pools). */
export interface DirectorStateHost {
  squadPool: {
    serialize(): DirectorSquadState[];
    restoreStates(states: readonly DirectorSquadState[]): void;
  };
  waveDirector: {
    serialize(): { waveCount: Array<[string, number]>; lastDispatchAtMs: Array<[string, number]> };
    restore(state: {
      waveCount: ReadonlyArray<readonly [string, number]>;
      lastDispatchAtMs: ReadonlyArray<readonly [string, number]>;
    }): void;
  };
  /** The director's hooks object (mutated in place by `setHooks`, so read live). */
  hooks: {
    saveSectorControl?: () => PersistedSectorControl[];
    restoreSectorControl?: (entries: readonly PersistedSectorControl[]) => void;
  };
}

/** Build the director's ABSTRACT continuity payload (per-squad
 *  sector/target/state + wave bookkeeping + optional sector control). */
export function buildDirectorState(host: DirectorStateHost, savedAtMs: number): DirectorStatePayload {
  const wave = host.waveDirector.serialize();
  const control = host.hooks.saveSectorControl?.();
  return {
    version: DIRECTOR_STATE_VERSION,
    savedAtMs,
    squads: host.squadPool.serialize(),
    waveCount: wave.waveCount,
    lastDispatchAtMs: wave.lastDispatchAtMs,
    ...(control !== undefined ? { sectorControl: control } : {}),
  };
}

/**
 * Overlay a hydrated payload onto the freshly-seeded director: restore each
 * known squad's sector/target/state + the wave bookkeeping (+ sector control).
 * The existing respawn + plan machinery then re-spawns bots at the restored
 * sectors and resumes / stands down.
 */
export function applyDirectorState(host: DirectorStateHost, p: DirectorStatePayload): void {
  // PR 3a — a wave target (faction id == owner playerId) persisted under one
  // of the account's historical per-browser ids maps to the canonical id.
  host.squadPool.restoreStates(p.squads.map((s) => ({
    ...s,
    targetFactionId: s.targetFactionId === null ? null : canonicalPlayerId(s.targetFactionId),
  })));
  host.waveDirector.restore({
    waveCount: p.waveCount.map(([k, v]) => [canonicalPlayerId(k), v] as [string, number]),
    lastDispatchAtMs: p.lastDispatchAtMs.map(([k, v]) => [canonicalPlayerId(k), v] as [string, number]),
  });
  if (p.sectorControl !== undefined) host.hooks.restoreSectorControl?.(p.sectorControl);
  serverLogEvent('director_state_restored', { squads: p.squads.length, sectorControl: p.sectorControl?.length ?? 0 });
}
