# Persistence and Migrations

This document covers EQX Peri's persistence pipeline — the path data takes
from the live `SectorRoom` to disk, and the contract by which we evolve that
data over time without losing or corrupting it.

## Layers (Phase 7 + Phase 8 sub-phase A)

```
┌──────────────────────┐
│  SectorRoom (main)   │  emits ops via persistence.enqueueCritical(...)
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ WorkerBackedSink     │  50 ms WAB coalesce, in-memory CRITICAL queue,
│ (main thread)        │  10 000-op cap force-flush, oldest-drop VOLATILE
└──────────┬───────────┘
           │  postMessage({ type: 'BATCH', ops })
┌──────────▼───────────┐
│ dbWorker             │  sole writer to eqx.db. Applies BATCH ops inside a
│ (worker_threads)     │  BEGIN/COMMIT transaction. Prepared statements
│                      │  cached. WAL + synchronous=NORMAL.
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ eqx.db (SQLite WAL)  │  authoritative on-disk state.
└──────────────────────┘
```

The main thread holds a **read-only** `node:sqlite` connection (lazy-opened
in [src/server/db/Database.ts](../../src/server/db/Database.ts)) for SELECT
paths only. All writes flow through the sink. This invariant comes from
Phase 7; Phase 8 reuses it without modification.

## Phase 7 op union (closed set)

The `PersistOp` discriminated union at
[src/core/contracts/IPersistenceSink.ts](../../src/core/contracts/IPersistenceSink.ts)
enumerates every shape that can hit disk. Adding a new op is a code-review
event — bump the version in `dbWorker.ts`'s prepared-statement table and
the `applyOp` switch. Sub-phase B adds `LIMBO_PUT` / `LIMBO_DELETE` /
`LIMBO_GET` here.

## Phase 8 sub-phase A: sector snapshots

`game_snapshots` (defined in
[src/server/db/schema.ts](../../src/server/db/schema.ts)) was wired through
the sink in Phase 7 but never called. Sub-phase A activates it:

- **Cadence**: every 60 s (3 600 ticks at 60 Hz) inside `SectorRoom.update`,
  plus once on `SectorRoom.onDispose`.
- **Scope**: galaxy sectors only (`sectorKey !== null`). Engineering rooms
  do not snapshot — their state is ephemeral by design.
- **Payload**: defined by
  [SectorSnapshotPayload](../../src/server/rooms/SectorSnapshot.ts):
  ```
  { schemaVersion, sectorKey, savedAtMs, swarm: [{ entityId, kind, x, y, health }] }
  ```
- **What's persisted**: swarm health (drones; asteroids carry `health: 0`
  for diagnostics but aren't tracked). **What's not**: ships
  (those go to Limbo, not snapshots — see sub-phase B), projectiles
  (short-lived), positions (deterministic from the seed; restoring positions
  would re-introduce the entity-id-stability problem on shape changes).
- **Hydration on `onCreate`**: query the most recent row for this
  `sectorKey`, run it through `parseSnapshot`. If schema mismatches or
  the row is older than 24 h (`SNAPSHOT_STALENESS_MS`), discard and
  fresh-spawn from config. Otherwise restore swarm health for entities
  whose IDs are still in the registry.

The 24 h cap prevents zombie state from a long downtime — a sector that
sat untouched for a week shouldn't come back with stale drone wreckage.

## The `schemaVersion` paradigm

Every snapshot payload carries a `schemaVersion: number` field, defined as
`CURRENT_SCHEMA_VERSION` in
[src/server/rooms/SectorSnapshot.ts](../../src/server/rooms/SectorSnapshot.ts).
On hydrate, `parseSnapshot` checks: if `version !== CURRENT_SCHEMA_VERSION`,
it routes the payload through `migrateSnapshot(raw, fromV, toV)`.

**Phase 8 strategy: tear-down-on-change.** `migrateSnapshot` throws by
default. The `SectorRoom.hydrateFromSnapshot` caller catches the throw and
falls through to fresh-spawn. So the canonical workflow when introducing a
breaking sector-shape change is:

1. Bump `CURRENT_SCHEMA_VERSION`.
2. Deploy.
3. On next boot, every existing snapshot fails the version check and is
   silently discarded. All sectors fresh-spawn from config. The state of
   the galaxy resets, cleanly.

When a future phase needs to **preserve** data across a bump (e.g. a
seasonal reset that retains player-attributable kill stats but resets
swarm health), register a real migration in `migrateSnapshot`:

```ts
export function migrateSnapshot(raw, fromV, toV) {
  if (fromV === 1 && toV === 2) {
    // Mechanical transform from v1 shape to v2 shape, returning the v2
    // SectorSnapshotPayload. Throws on partial failure.
    return migrateV1toV2(raw);
  }
  throw new Error(`No migration from v${fromV} to v${toV}.`);
}
```

`parseSnapshot` will return the migrated payload as if it had been a
current-version snapshot all along. Document the migration in `LESSONS.md`.

## Why not always migrate?

Two reasons.

1. **Cost vs benefit.** Sector swarm health resets every 60 s anyway under
   normal play (drones die, drones respawn, etc.). Losing one snapshot's
   worth of state is a non-event. Writing a real migration for a one-off
   shape change is real engineering work and real test surface — better to
   pay it only when the data has player-facing value (kill counts, login
   history) that justifies the effort.
2. **Test discipline.** A one-line `CURRENT_SCHEMA_VERSION` bump is hard to
   get wrong. A 50-line migration is not — and migrations are notoriously
   under-tested because the only data they apply to is in production. The
   tear-down strategy moves the failure mode from "subtle data corruption"
   to "everyone respawns once" which is a much better failure mode.

## What kinds of changes need a version bump?

- Adding/removing/renaming fields in `SectorSnapshotPayload`.
- Changing the meaning of an existing field (e.g. `health` going from
  scalar to fraction).
- Changing the entityId scheme so old IDs no longer exist in the registry.
- Changing the sector-`asteroidConfigKey` mapping in a way that breaks
  existing entityIds.

## What changes don't need a bump?

- Adding a new sector to `GALAXY_SECTORS` — old snapshots for existing
  sectors hydrate normally; the new sector has no snapshot and fresh-spawns.
- Tuning existing constants (drone count, asteroid layout values) — old
  snapshots hydrate, restored entityIds may or may not still be present in
  the new registry, but the missing entries silently fall through.

## Testing the migration paradigm

[`SectorSnapshot.test.ts`](../../src/server/rooms/SectorSnapshot.test.ts)
covers:

- Round-trip of a current-version payload.
- Throw on missing `schemaVersion`.
- Throw on non-current `schemaVersion` (routes through `migrateSnapshot`,
  which throws by default).
- The `migrateSnapshot` default behaviour.

When you register a real migration, add tests covering both the migration
path and the no-op path (current-version payload still passes through).

## Future plans

- **Runtime zod validation at hydrate time.** `parseSnapshot` currently
  trusts the post-version-check payload shape. A zod schema would make
  partial corruption (one bad row in a thousand) a defensive
  fresh-spawn rather than a runtime throw.
- **Automated migration testing.** A test fixture pinning every historical
  schema version's payload, plus a test that walks all `(fromV, toV)` pairs
  registered in `migrateSnapshot` and confirms the output validates against
  the target zod schema.
- **Multi-VM Redis swap (far future).** When EQX moves to multiple VMs,
  Limbo migrates from in-memory to Redis (sub-phase B's `LimboStore`
  contract is designed for this). The `IPersistenceSink` shadow keeps the
  SQLite trail useful as a tertiary recovery path during the migration.
- **Per-sector partition tables.** If a single galaxy sector ever produces
  tens of millions of kill rows, partition `player_kills` by `sector_id`
  with a view over the partitions. Not a Phase 8 concern.
- **`GAME_SNAPSHOT` retention policy.** Today every 60-second snapshot
  inserts a row; old rows are never pruned. After ~24 h the hydrate query
  ignores them but the rows still occupy disk. A future phase can add a
  TTL prune (`DELETE FROM game_snapshots WHERE created_at < ?`) on the
  worker side — straightforward extension of `dbWorker.ts`'s op switch.
