/**
 * Persist + hydrate the sector's volatile state across server restarts.
 *
 * Phase 5 (2026-06-14) — the persistence model is moving toward a BLACKLIST:
 * the world persists by default, only genuinely transient things are excluded.
 * Today this carries swarm health (asteroids) AND fully-reconstructable
 * STRUCTURES (owner / subtype / pose / construction / minerals / power) — the
 * latter fixing "structures are lost after server reset". Still excluded:
 * roaming drones (kind 1, re-seeded at entry sectors by the warp-in director)
 * and scrap (kind 3, transient debris); projectiles/missiles were never swarm
 * entities and are never persisted.
 *
 * Galaxy rooms snapshot once every 60 s during play (and on `onDispose`);
 * hydrate is called once on `onCreate`. Engineering rooms (sectorKey null) skip
 * both — their state is ephemeral by design.
 *
 * The DB read/write is INJECTED (`saveRow` / `loadRow`) so the persist↔hydrate
 * round-trip is unit-testable without the real sqlite worker.
 */

import type { Logger } from 'pino';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { SWARM_KIND_SCRAP } from '../../shared-types/swarmWireFormat.js';
import {
  CURRENT_SCHEMA_VERSION,
  SNAPSHOT_STALENESS_MS,
  parseSnapshot,
  type SectorSnapshotPayload,
  type SectorSnapshotStructure,
  type SectorSnapshotScrap,
  type SectorSnapshotLingeringHull,
} from './SectorSnapshot.js';

/** The minimal structure shape `persist()` reads (a subset of `StructureRecord`). */
export interface PersistableStructure {
  id: string;
  owner: string;
  kind: string;
  x: number;
  y: number;
  isConstructed: boolean;
  constructionProgress: number;
  minerals: number;
  storedPower: number;
}

export interface SectorPersistenceDeps {
  sectorKey: () => string | null;
  sabF32: Float32Array;
  swarmRegistry: {
    all(): Iterable<{ id: string; slot: number; kind: number }>;
    has(entityId: string): boolean;
  };
  /** Per-entity hull pool — drones/structures are killable; asteroids absent. */
  swarmHealth: Map<string, number>;
  /** Placed structures to persist (the server `StructureRegistry`). */
  structures: () => Iterable<PersistableStructure>;
  /** Reconstruct the placed structures on hydrate (re-place + restore state +
   *  rebuild the grid). Owned by `SectorRoom` (it holds the spawn machinery). */
  restoreStructures: (rows: readonly SectorSnapshotStructure[]) => void;
  /** Free-floating scrap pieces to persist (pose from SAB + parent kind +
   *  componentIndex + health). Owned by `SectorRoom` (it reads the SAB). */
  scrapEntities: () => Iterable<SectorSnapshotScrap>;
  /** Reconstruct the scrap pieces on hydrate (re-derive collider + spawn +
   *  seed health). Owned by `SectorRoom`. */
  restoreScrap: (rows: readonly SectorSnapshotScrap[]) => void;
  /** Lingering hulls to persist (the in-world disconnected/displaced ships).
   *  Owned by `SectorRoom` (it reads `lingeringSlots` + the schema + pose cache). */
  lingeringHulls: () => Iterable<SectorSnapshotLingeringHull>;
  /** Reconstruct the lingering hulls on hydrate (re-spawn the in-world hull).
   *  Owned by `SectorRoom`. Runs during hydrate (before any onJoin). */
  restoreLingeringHulls: (rows: readonly SectorSnapshotLingeringHull[]) => void;
  /** Write a snapshot row for this sector (production: `saveSnapshot`). */
  saveRow: (sectorKey: string, payload: SectorSnapshotPayload) => void;
  /** Load the most-recent snapshot row for this sector (production: a sqlite
   *  SELECT). Returns undefined when there is none. */
  loadRow: (sectorKey: string) => { snapshot: string; created_at: number } | undefined;
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
      // The persistence BLACKLIST (opt-out model). Drones (kind 1) are NOT
      // persisted via the sector snapshot — they are owned by the
      // LivingWorldDirector, which persists + re-dispatches its squad pool
      // itself (NOT here). Structures (kind 2) and scrap (kind 3) DO persist,
      // but via their richer dedicated arrays below (the bare swarm row lacks
      // owner/construction for a structure, parent-kind/componentIndex for
      // scrap). So the generic swarm[] row carries only asteroids (kind 0).
      if (rec.kind === 1) continue;
      if (rec.kind === SWARM_KIND_SCRAP) continue;
      if (rec.kind === 2) continue;
      // Asteroids (kind 0): pose + health. Position isn't restored (deterministic
      // from the seed) but is recorded for diagnostics.
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
    const structures: SectorSnapshotStructure[] = [];
    for (const s of d.structures()) {
      structures.push({
        entityId: s.id,
        owner: s.owner,
        kind: s.kind,
        x: s.x,
        y: s.y,
        health: d.swarmHealth.get(s.id) ?? 0,
        isConstructed: s.isConstructed,
        constructionProgress: s.constructionProgress,
        minerals: s.minerals,
        storedPower: s.storedPower,
      });
    }
    const scrap: SectorSnapshotScrap[] = [];
    for (const s of d.scrapEntities()) scrap.push(s);
    const lingeringHulls: SectorSnapshotLingeringHull[] = [];
    for (const h of d.lingeringHulls()) lingeringHulls.push(h);
    const payload: SectorSnapshotPayload = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sectorKey,
      savedAtMs: Date.now(),
      swarm,
      ...(structures.length > 0 ? { structures } : {}),
      ...(scrap.length > 0 ? { scrap } : {}),
      ...(lingeringHulls.length > 0 ? { lingeringHulls } : {}),
    };
    try {
      d.saveRow(sectorKey, payload);
    } catch (err) {
      d.logger.warn({ err, sectorKey }, 'sector snapshot enqueue failed');
    }
  }

  /**
   * Look up the most recent on-disk snapshot for this sector and restore swarm
   * health + reconstruct placed structures. Discards rows that mismatch
   * CURRENT_SCHEMA_VERSION or exceed SNAPSHOT_STALENESS_MS; the caller falls
   * through to fresh-spawn.
   */
  hydrate(): void {
    const d = this.deps;
    const sectorKey = d.sectorKey();
    if (sectorKey === null) return;
    let row: { snapshot: string; created_at: number } | undefined;
    try {
      row = d.loadRow(sectorKey);
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
      // Asteroids aren't health-tracked; drones aren't persisted. Only
      // health-bearing already-spawned entities get their HP restored here.
      if (e.kind !== 0) continue;
      if (d.swarmRegistry.has(e.entityId)) {
        d.swarmHealth.set(e.entityId, e.health);
        restored += 1;
      }
    }
    const structures = payload.structures ?? [];
    if (structures.length > 0) {
      try {
        d.restoreStructures(structures);
      } catch (err) {
        d.logger.warn({ err, sectorKey }, 'structure restore failed — partial hydrate');
      }
    }
    const scrap = payload.scrap ?? [];
    if (scrap.length > 0) {
      try {
        d.restoreScrap(scrap);
      } catch (err) {
        d.logger.warn({ err, sectorKey }, 'scrap restore failed — partial hydrate');
      }
    }
    const lingeringHulls = payload.lingeringHulls ?? [];
    if (lingeringHulls.length > 0) {
      try {
        d.restoreLingeringHulls(lingeringHulls);
      } catch (err) {
        d.logger.warn({ err, sectorKey }, 'lingering-hull restore failed — partial hydrate');
      }
    }
    d.logger.info(
      {
        sectorKey,
        ageMs,
        restored,
        structures: structures.length,
        scrap: scrap.length,
        lingeringHulls: lingeringHulls.length,
      },
      'sector hydrated from snapshot',
    );
  }
}
