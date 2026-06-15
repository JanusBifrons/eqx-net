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
`LIMBO_GET` here; Phase 2 adds `PLAYER_SHIP_PUT` / `PLAYER_SHIP_DELETE`; Phase 5
adds `DIRECTOR_STATE_PUT` (the Director-state lane below).

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
  { schemaVersion, sectorKey, savedAtMs,
    swarm: [{ entityId, kind, x, y, health }],
    structures?: [{ entityId, owner, kind, x, y, health,
                    isConstructed, constructionProgress, minerals, storedPower }],
    scrap?: [{ entityId, parentShipKind, componentIndex, x, y, vx, vy, angle, health }],
    lingeringHulls?: [{ shipInstanceId, playerId, kind, x, y, vx, vy, angle, angvel,
                        health, shieldDown }] }
  ```
- **What's persisted** (opt-out / BLACKLIST model — the world persists by default):
  asteroid swarm health; (schema v3) the FULL state of placed **structures**
  (owner / subtype / pose / construction / minerals / power — positions DO
  persist, they're player-placed; connections re-derive from the auto-connect
  sweep); (schema v4) **scrap** (drifted pose + parent ship-kind + componentIndex
  + health — the collider re-derives on hydrate from `(parentShipKind,
  componentIndex)` via `scrapColliderFor`, so it's never persisted); and (schema
  v5) **lingering hulls** (a disconnected/displaced `isActive=false` ship) so they
  reappear in-world "where you left it" after a restart, reclaimable until
  abandoned (→ scrap). Sector-keyed, NOT a roster scan — `markActive` doesn't
  update the roster `lastSectorKey`, so the snapshot's stable `sectorKey` is the
  reliable source.
- **What's NOT persisted via the sector snapshot**: projectiles/missiles
  (ephemeral); ACTIVE ships (the roster — `PlayerShipStore` — holds them with no
  TTL, the owner's reclaim path; the 10-ship cap stays); and **roaming DRONES
  (kind 1)** — owned by the `LivingWorldDirector`, which is responsible for
  persisting + re-dispatching its own squad pool (it must "restart from any state"
  and direct the nearest roaming groups). Not "ignored" — a different persistence
  owner.
- **Hydration on `onCreate`**: query the most recent row for this
  `sectorKey`, run it through `parseSnapshot`. If schema mismatches or
  the row is older than 24 h (`SNAPSHOT_STALENESS_MS`), discard and
  fresh-spawn from config. Otherwise restore asteroid swarm health for entities
  whose IDs are still in the registry; RECONSTRUCT each persisted structure
  (re-place via `structurePlacement.place`, restore construction/minerals/power/
  health, then one grid pulse re-forms the web); RECONSTRUCT each scrap piece
  (re-derive collider, `swarmSpawner.spawnScrap`, seed health); and RECONSTRUCT
  each lingering hull (a `new ShipState()` `isActive=false` entry + SAB pose +
  `linger-<id>` worker body + lingering bookkeeping — run BEFORE any onJoin, and
  skipped if the roster row is gone so an abandoned ship isn't resurrected).

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

## Limbo lane — RETIRED (Phase 5 / WS-B, 2026-06-14)

`LimboStore` is **deleted**. It previously held a player's ship state in two
cases — a 15-min disconnect reconnect window and a 30-s transit-in-flight
reservation — as an in-memory map shadowed through `LIMBO_PUT`/`LIMBO_DELETE`.
Both roles are now served by the **roster** (`PlayerShipStore`):

- **Disconnect** → `RosterPersistence.markLinger` freezes the roster row at the
  last pose; the in-world hull also persists via `lingeringHulls[]` in the sector
  snapshot, and a returning player resumes by shipId (the `onJoin` shipId-restore
  path). The roster `expiresAt` is **unenforced** (no prune sweep), so a lingering
  hull persists forever (R2.26) until combat / respawn-evict / abandon → scrap.
- **Transit-in-flight** → `TransitOrchestrator.commitTransit` `markStored`s the
  roster row at the destination sector with the commit pose and threads the shipId
  through `reserveSeatFor`; the destination `onJoin` shipId-restore is the single
  path for BOTH reconnect and transit-arrival. No 30-s expiry — an aborted hop
  just leaves the ship stored at the destination (reclaimable).

Removed: the `LIMBO_PUT`/`LIMBO_DELETE`/`LIMBO_GET` ops, `initLimboStore` + the
prune timer, and the boot/shutdown Limbo wiring. `/dev/limbo` is a back-compat
stub (`{ exists: false }`) so the client + E2E stay green. The `limbo` SQLite
table + a one-release `limbo`→roster backfill (in `initPlayerShipStore`) are
kept for ONE release so in-flight entries from the pre-deploy build migrate into
the roster, then both are dropped in a follow-up.

## Director-state lane (Phase 5 — "restart from any state")

The process-global `LivingWorldDirector` owns the hunter-bot squads, and drones
are deliberately NOT in the per-sector snapshot (they're director-owned, re-seeded
at entry sectors). So the director persists its OWN continuity, on its own lane.

[`DirectorPersistence`](../../src/server/livingworld/DirectorPersistence.ts)
mirrors `SectorPersistence`: an injected `saveRow`/`loadRow` round-trip, a
`DIRECTOR_STATE_VERSION` (tear-down-on-change, like `schemaVersion`) and a 24 h
staleness gate. It shadows only the ABSTRACT squad continuity into a **singleton**
`director_state` row (`id = 1`, UPSERT) via the new `DIRECTOR_STATE_PUT` CRITICAL
op:

- per squad: `{squadId, kind, sectorKey, targetFactionId, state}` (membership is
  re-derived by `SquadPool.seed`; the per-wave `warned` one-shot is dropped);
- the `WaveDirector`'s `waveCount` + `lastDispatchAtMs` maps (absolute wall-clock,
  so the dispatch rate-cap still gates correctly across a restart).

**When it writes:** on graceful shutdown (`index.ts`, before the persistence
drain) and throttled from the 1.5 s control-loop tail (`DIRECTOR_PERSIST_INTERVAL_MS`
60 s, crash defence). Both are CRITICAL enqueues off the 60 Hz `update()` path —
no netgate.

**When it reads:** once, inside `LivingWorldDirector.start()`, AFTER the fresh
seed. A `null` hydrate (no row / stale / version-mismatch / corrupt) falls through
to today's fresh seed — so an empty DB or a `DIRECTOR_STATE_VERSION` bump is a
clean reseed. On a hit, `SquadPool.restoreStates` + `WaveDirector.restore` overlay
the continuity and the existing `respawnStep` re-spawns bots at each squad's
restored sector (entry-only-ingress preserved: interior goals ingress at the edge
and hop-traverse inward).

**Not persisted:** individual bot poses + in-flight `BotTransitController` warps
(a mid-flight hop resets to the squad's sector on restart). The fixed 24-bot pool
is always re-seeded — only squad ASSIGNMENTS persist.

## Ship-kind catalogue drift (`player_ships.kindVersion`)

Distinct from the snapshot `schemaVersion` above: persistent roster rows in
`player_ships` carry a `kindVersion` stamping the `SHIP_KIND_CATALOGUE_VERSION`
([src/shared-types/shipKinds.ts](../../src/shared-types/shipKinds.ts)) they
were last saved at. On hydrate, `applyKindVersionDrift`
([src/server/playerShips/PlayerShipStore.ts](../../src/server/playerShips/PlayerShipStore.ts))
reconciles a stale row: it **clamps `health` to the current kind's
`maxHealth` (DOWN only — `Math.min`)** and re-stamps the version. Every other
numeric stat (speed, thrust, damping, grip, angvel, regen) is **never cached
on the row** — it is read live off the catalogue per physics frame via
`getShipKind(row.kind)`, so a catalogue retune takes effect instantly for
every player, returning or new, with no migration.

**Bumping rule (invariant #11):** any PR that edits a numeric field inside
`SHIP_KINDS` MUST bump `SHIP_KIND_CATALOGUE_VERSION` by 1 in the same PR.
There is **no SQLite migration** — the `kindVersion` stamp + the live-read
design *is* the entire migration mechanism.

### v2 → v3 (2026-05-18, "slow down gameplay")

- 0.5× ship speed (halved `thrustImpulse` / `maxSpeed` / `ai.thrust` for all
  5 kinds), turn rate unchanged, ×1.5 hull + shield with `shieldRegenRate`
  also ×1.5 (full-shield regen *time* held constant), and 10× warp spool
  (a transit-timing constant, unrelated to persisted rows).
- **Documented asymmetry — the +50% hull is NOT back-filled onto existing
  stored rows.** `applyKindVersionDrift` clamps *down* only; it never gifts
  hull. A returning player's stored ship keeps its stored health and reaches
  the new (higher) cap only on its next fresh spawn / shield+hull reset, by
  design. This is correct (never strip earned damage, never gift hull above
  the cap the player last saw) and is regression-locked by
  `PlayerShipStore.test.ts` ("drift does not gift hull when stored health is
  below current maxHealth"). The speed/regen half of the retune *is* instant
  for stored ships (live-read). If a future reader files "returning ships
  have old health", this is the expected behaviour, not a bug.

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
