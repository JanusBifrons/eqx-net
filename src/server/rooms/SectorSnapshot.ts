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
// v4 (Phase 5 2026-06-14): SCRAP persists too.
// v5 (Phase 5 2026-06-14): LINGERING HULLS persist too — a disconnected /
// displaced ship reappears in its sector "where you left it" after a restart
// (visible to others, reclaimable by the owner). The 10-ship roster cap stays;
// ships persist once spawned until abandoned (→ scrap). Bumping discards every
// older snapshot and reseeds all sectors.
// v6 (Phase 4 leveling/XP, WS-0): structures[] gain a `level` (default 1) — the
// per-structure progression an Upgrade build phase increments (WS-B4). Tear-down
// on the bump: every v5 snapshot is discarded and all sectors fresh-spawn.
export const CURRENT_SCHEMA_VERSION = 6;

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
  /** Phase 4 (Leveling & XP, WS-0) — structure level (≥ 1). A fresh structure
   *  is level 1; the Upgrade build phase (WS-B4) increments it. Optional on the
   *  TYPE for back-compat with older in-process callers, but always written by
   *  `SectorPersistence.persist()` (defaulting to 1). The schema bump to v6
   *  discards every persisted v5 row, so a hydrated row always carries it. */
  level?: number;
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

/**
 * A lingering hull (a disconnected / fresh-spawn-displaced ship, `isActive=false`,
 * still drifting in the sector). Persisted so it reappears in-world after a
 * server restart (Phase 5 v5). The `shipInstanceId` is the roster shipId — the
 * stable hull identity across disconnect↔reconnect↔abandon — so reconnect rebinds
 * to the reconstructed hull and abandon→scrap still keys correctly.
 */
export interface SectorSnapshotLingeringHull {
  shipInstanceId: string;
  playerId: string;
  kind: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
  health: number;
  /** True if the shield was down at persist time (hull exposed). */
  shieldDown: boolean;
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
  /** Lingering hulls (Phase 5 v5 — "lingers forever where you left it"). Absent
   *  when none. */
  lingeringHulls?: SectorSnapshotLingeringHull[];
}

/**
 * Future migration entrypoint. Phase 8 strategy: tear-down-on-change.
 * When a future phase needs to preserve data across a schema bump, register
 * a migration here. Until then, throwing forces a clean fresh-spawn — which
 * is also what `hydrateFromSnapshot` does on schema mismatch (it catches the
 * throw and falls through to fresh-spawn).
 */
export function migrateSnapshot(_snap: unknown, fromV: number, toV: number): SectorSnapshotPayload {
  // v5 → v6 (Phase 4 leveling/XP, WS-0): structures[] gained a `level` field.
  // The added field defaults to 1 and there is no player-facing value in
  // preserving a v5 galaxy across the bump, so this stays a tear-down arm
  // (Phase-8 strategy) — throw, and the hydrate caller fresh-spawns. Kept as an
  // explicit arm so a future preserving migration slots in by replacing the
  // throw with a mechanical v5→v6 transform.
  if (fromV === 5 && toV === 6) {
    throw new Error(
      `No migration from sector-snapshot schema v5 to v6 (structures[].level added). ` +
      `Tear-down-on-change: every v5 snapshot is discarded and all sectors fresh-spawn.`,
    );
  }
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
