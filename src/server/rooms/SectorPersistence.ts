/**
 * Persist + hydrate the sector's volatile state (swarm health) across
 * server restarts.
 *
 * Galaxy rooms snapshot once every 60 s during play (and on
 * `onDispose`); hydrate is called once on `onCreate`. Engineering
 * rooms (sectorKey null) skip both — their state is ephemeral by
 * design.
 *
 * Composes the dormant `saveSnapshot` op + the schema-version + age
 * gate. Mismatched / stale rows fall through to fresh-spawn.
 *
 * Extracted from SectorRoom (commit 22 partial).
 */

import type { Logger } from 'pino';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { db } from '../db/Database.js';
import { saveSnapshot } from '../stats/StatsService.js';
import {
  CURRENT_SCHEMA_VERSION,
  SNAPSHOT_STALENESS_MS,
  parseSnapshot,
  type SectorSnapshotPayload,
} from './SectorSnapshot.js';

export interface SectorPersistenceDeps {
  sectorKey: () => string | null;
  sabF32: Float32Array;
  swarmRegistry: {
    all(): Iterable<{ id: string; slot: number; kind: number }>;
    has(entityId: string): boolean;
  };
  /** Per-entity hull pool — drones are killable; asteroids absent. */
  swarmHealth: Map<string, number>;
  logger: Logger;
}

export class SectorPersistence {
  constructor(private readonly deps: SectorPersistenceDeps) {}

  /** Galaxy-only — engineering rooms have no persistent identity. */
  persist(): void {
    const d = this.deps;
    const sectorKey = d.sectorKey();
    if (sectorKey === null) return;
    const swarm: SectorSnapshotPayload['swarm'] = [];
    for (const rec of d.swarmRegistry.all()) {
      // Drones (kind 1) are NO LONGER persisted (drone-warp-in, 2026-06-11):
      // they are transient — owned by the roaming LivingWorldDirector pool and
      // re-seeded at entry sectors on boot, so persisting their health is
      // meaningless (and a cold boot deliberately starts with an empty interior).
      if (rec.kind === 1) continue;
      // Asteroids aren't tracked in swarmHealth; default to 0
      // (unused on restore because asteroids aren't kill-tracked).
      const health = d.swarmHealth.get(rec.id) ?? 0;
      const b = slotBase(rec.slot);
      swarm.push({
        entityId: rec.id,
        kind: rec.kind,
        x: d.sabF32[b + SLOT_X_OFF]!,
        y: d.sabF32[b + SLOT_Y_OFF]!,
        health,
      });
    }
    const payload: SectorSnapshotPayload = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sectorKey,
      savedAtMs: Date.now(),
      swarm,
    };
    try {
      saveSnapshot(sectorKey, payload);
    } catch (err) {
      d.logger.warn({ err, sectorKey }, 'sector snapshot enqueue failed');
    }
  }

  /**
   * Look up the most recent on-disk snapshot for this sector and
   * restore swarm health (positions are deterministic from the seed
   * — not restored). Discards rows that mismatch
   * CURRENT_SCHEMA_VERSION or exceed SNAPSHOT_STALENESS_MS; the
   * caller falls through to fresh-spawn.
   */
  hydrate(): void {
    const d = this.deps;
    const sectorKey = d.sectorKey();
    if (sectorKey === null) return;
    let row: { snapshot: string; created_at: number } | undefined;
    try {
      row = db.prepare(
        'SELECT snapshot, created_at FROM game_snapshots WHERE sector_id = ? ORDER BY created_at DESC LIMIT 1',
      ).get(sectorKey) as { snapshot: string; created_at: number } | undefined;
    } catch (err) {
      d.logger.warn({ err, sectorKey }, 'snapshot hydrate query failed — fresh spawn');
      return;
    }
    if (!row) {
      d.logger.info({ sectorKey }, 'no prior snapshot — fresh sector spawn');
      return;
    }
    const ageMs = Date.now() - row.created_at;
    if (ageMs > SNAPSHOT_STALENESS_MS) {
      d.logger.info({ sectorKey, ageMs }, 'snapshot stale — fresh sector spawn');
      return;
    }
    let payload: SectorSnapshotPayload;
    try {
      payload = parseSnapshot(JSON.parse(row.snapshot));
    } catch (err) {
      d.logger.warn({ err, sectorKey }, 'snapshot parse/version mismatch — fresh sector spawn');
      return;
    }
    let restored = 0;
    for (const e of payload.swarm) {
      // Drones only — asteroids aren't health-tracked.
      if (e.kind !== 1) continue;
      if (d.swarmRegistry.has(e.entityId)) {
        d.swarmHealth.set(e.entityId, e.health);
        restored += 1;
      }
    }
    d.logger.info({ sectorKey, ageMs, restored }, 'sector hydrated from snapshot');
  }
}
