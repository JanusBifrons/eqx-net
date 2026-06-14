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

// v3 (Phase 5 2026-06-14): structures FULLY persisted + reconstructed.
// v4 (Phase 5 2026-06-14): SCRAP now persists too (pose + parent ship-kind +
// componentIndex + health; collider re-derived on hydrate). The persistence
// model is opt-out: the world persists by default; the blacklist is only
// genuinely transient/externally-owned things — projectiles/missiles
// (ephemeral) and roaming DRONES (kind 1, owned by the LivingWorldDirector,
// which persists + re-dispatches them itself, NOT via the sector snapshot).
// Bumping discards every older snapshot and reseeds all sectors.
export const CURRENT_SCHEMA_VERSION = 4;

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

/**
 * A placed structure, with the FULL state needed to reconstruct it on hydrate
 * (the swarm record only carries pose + health — owner / subtype / construction
 * / minerals / power live in the server `StructureRegistry`). Position IS
 * restored (structures are player-placed, NOT deterministic from the config
 * seed). Connections are NOT persisted — they re-derive from the auto-connect
 * sweep once the structures are re-placed.
 */
export interface SectorSnapshotStructure {
  /** Swarm entity id (also the binary-wire id) at save time. */
  entityId: string;
  /** Owning playerId. */
  owner: string;
  /** Structure subtype id (`StructureKindId`). */
  kind: string;
  x: number;
  y: number;
  /** Hull HP at save time. */
  health: number;
  /** Built vs blueprint. */
  isConstructed: boolean;
  /** Minerals delivered toward construction (0..constructionCost). */
  constructionProgress: number;
  /** Minerals stored here (the Capital bank / a Miner buffer). */
  minerals: number;
  /** Stored power (batteries). */
  storedPower: number;
}

/**
 * A free-floating scrap piece (kind 3, scrap-on-death). Persisted with its
 * drifted pose + parent ship-kind + scrap-group component index; the convex-hull
 * collider is RE-DERIVED on hydrate from `(parentShipKind, componentIndex)` (the
 * same `scrapColliderFor` mapping the death path uses), so it is never on the
 * wire NOR in the snapshot — only the small identifying fields are.
 */
export interface SectorSnapshotScrap {
  entityId: string;
  /** Parent ship-kind id the piece broke off of (rides the shared shipKind byte). */
  parentShipKind: string;
  /** Index into `shipScrapGroups(parentShipKind)`. */
  componentIndex: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** World math-up angle. */
  angle: number;
  health: number;
}

export interface SectorSnapshotPayload {
  schemaVersion: number;
  sectorKey: string;
  savedAtMs: number;
  swarm: SectorSnapshotEntity[];
  /** Placed structures, fully reconstructable (Phase 5 — was previously lost on
   *  restart). Absent on a sector that has none. */
  structures?: SectorSnapshotStructure[];
  /** Free-floating scrap pieces (Phase 5 v4). Absent when none. */
  scrap?: SectorSnapshotScrap[];
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
