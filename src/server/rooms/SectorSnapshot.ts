/**
 * Per-sector snapshot payload (Phase 8) — the volatile state we persist
 * across server restarts. Position is NOT included (deterministic from the
 * config seed); only swarm health, which is the only state that meaningfully
 * changes over time without ship interaction.
 *
 * Bumping `CURRENT_SCHEMA_VERSION` is the canonical "tear down all sectors
 * and reseed" knob. Any persisted snapshot whose version doesn't match the
 * current value is silently discarded at hydrate time and the sector
 * fresh-spawns from config. See docs/architecture/persistence-and-migrations.md.
 */

export const CURRENT_SCHEMA_VERSION = 1;

/** Maximum age of a hydrated snapshot before it's discarded (24 h). */
export const SNAPSHOT_STALENESS_MS = 24 * 60 * 60 * 1000;

export interface SectorSnapshotEntity {
  entityId: string;
  /** 0 = asteroid, 1 = drone, 2 = structure — matches `SwarmKind`. */
  kind: number;
  /** Last-known position. Recorded for diagnostics; NOT restored on hydrate
   *  (positions are deterministic from config; restoring would create entity-id
   *  stability problems on shape changes). */
  x: number;
  y: number;
  /** The actually-persisted state: how much HP this entity has left. */
  health: number;
}

export interface SectorSnapshotPayload {
  schemaVersion: number;
  sectorKey: string;
  savedAtMs: number;
  swarm: SectorSnapshotEntity[];
}

/**
 * Future migration entrypoint. Phase 8 strategy: tear-down-on-change.
 * When a future phase needs to preserve data across a schema bump, register
 * a migration here. Until then, throwing forces a clean fresh-spawn — which
 * is also what `hydrateFromSnapshot` does on schema mismatch (it catches the
 * throw and falls through to fresh-spawn).
 */
export function migrateSnapshot(_snap: unknown, fromV: number, toV: number): SectorSnapshotPayload {
  throw new Error(
    `No migration from sector-snapshot schema v${fromV} to v${toV}. ` +
    `Bump CURRENT_SCHEMA_VERSION to discard old snapshots and reseed all sectors, ` +
    `or register a migration here.`,
  );
}

/**
 * Validates a parsed JSON object as a current-version snapshot. Returns the
 * payload if valid; throws otherwise. Caller is responsible for catching and
 * falling through to fresh-spawn.
 */
export function parseSnapshot(raw: unknown): SectorSnapshotPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('parseSnapshot: not an object');
  }
  const obj = raw as Record<string, unknown>;
  const v = obj['schemaVersion'];
  if (typeof v !== 'number') {
    throw new Error('parseSnapshot: missing schemaVersion');
  }
  if (v !== CURRENT_SCHEMA_VERSION) {
    return migrateSnapshot(obj, v, CURRENT_SCHEMA_VERSION);
  }
  // Trust the shape past this point — sole writer is this codebase.
  return obj as unknown as SectorSnapshotPayload;
}
