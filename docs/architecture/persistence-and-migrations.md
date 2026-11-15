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
                    isConstructed, constructionProgress, minerals, storedPower, level }],
    scrap?: [{ entityId, parentShipKind, componentIndex, x, y, vx, vy, angle, health }],
    lingeringHulls?: [{ shipInstanceId, playerId, kind, x, y, vx, vy, angle, angvel,
                        health, shieldDown }] }
  ```
  - (schema **v6**, Phase 4 leveling/XP WS-0) `structures[].level` (default 1) —
    the per-structure level an Upgrade build phase (WS-B4) increments. The bump
    5 → 6 is a TEAR-DOWN (`migrateSnapshot` v5→v6 throws); every v5 snapshot is
    discarded and all sectors fresh-spawn.
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

### Roster columns + the idempotent-ALTER pattern (Phase 4 leveling/XP, WS-0)

Phase 4 adds per-ship-instance progression columns to `player_ships`:
`level (INTEGER DEFAULT 1)`, `xp (INTEGER DEFAULT 0)`,
`stat_alloc (TEXT DEFAULT '{}')`, `mounts (TEXT DEFAULT '[]')`. They ride the
`PLAYER_SHIP_PUT` op (`level` / `xp` / `statAllocJson` / `mountsJson`) and the
`PlayerShipStore` record (`level` / `xp` / `statAlloc` / `mounts`); a fresh ship
defaults to level 1 / xp 0 / empty maps.

Because `SCHEMA_SQL` uses `CREATE TABLE IF NOT EXISTS`, a table from an older
deploy is NOT re-created with the new columns. SQLite has no
`ADD COLUMN IF NOT EXISTS`, so the worker (`dbWorker.ts`, the sole writer) runs
`PLAYER_SHIPS_MIGRATIONS` (a list of `ALTER TABLE … ADD COLUMN …` exported from
`schema.ts`) AFTER `db.exec(SCHEMA_SQL)`, each inside a try/catch that swallows
the "duplicate column name" error — that makes the whole list **idempotent** (a
fresh DB already has the columns and skips them; an old DB gains them at the
catalogue DEFAULTs). This extends the `kindVersion` precedent (which lived in
the original CREATE TABLE) to a true in-place migration so existing roster rows
survive. Locked by `dbWorker.integration.test.ts` ("round-trips the Phase 4
leveling columns" + "the idempotent ALTER adds the leveling columns to a
pre-existing DB without them").

**Economy v2 adds `hull_quality (INTEGER DEFAULT 0)`** the same way: one more
`PLAYER_SHIPS_MIGRATIONS` entry, the optional `hullQuality` field on the
`PLAYER_SHIP_PUT` op (absent ⇒ 0), and `PlayerShipStore.hullQuality`. It's the
packed hull's quality for a ship unpacked from a crate (a small max-hull bonus);
0 for every other ship.

The boot-hydrate row mapping (`initPlayerShipStore`) parses `stat_alloc` /
`mounts` JSON defensively (`parseStatAlloc` / `parseMounts` → `{}` / `[]` on
absence / corruption / wrong shape) so one bad row never throws the whole boot.

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

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Phase 7 — SQLite persistence (shipped)**: WAL + `synchronous=NORMAL`. The `dbWorker` (`src/server/db/dbWorker.ts`) is the **sole writer**, spawned via `bundleWorker` at server startup from `src/server/index.ts:main()`. Two priority lanes through `IPersistenceSink` (`src/core/contracts/IPersistenceSink.ts`):
  - **CRITICAL** — coalesced through a 50 ms write-ahead buffer in `WorkerBackedSink`, flushed as one `BATCH` postMessage per window, applied inside a `BEGIN`/`COMMIT` transaction. WAB cap 10 000 ops force-flushes synchronously on overrun. `enqueueCriticalAwaitable` exists for callers that need the rowid back synchronously (auth `register` only); 2 s timeout.
  - **VOLATILE** — fire-and-forget telemetry (Phase 6 `ENTITY_SHED`, sleep transitions, sampled `LASER_FIRED`). Drains immediately when the worker is alive; buffered up to 5 000 with oldest-drop while the worker is unavailable.
  Auth keeps a **read-only** main-thread `DatabaseSync` (lazy-opened in `Database.ts`) for `SELECT` paths; all writes flow through the sink. `recordGameJoin`/`recordGameLeave` correlate via `play_id` (no rowid round-trip). SIGINT/SIGTERM in `index.ts` await `persistence.shutdown({ timeoutMs: 8000 })` then `gameServer.gracefullyShutdown()`. On Windows dev, the `pnpm dev:server` wrapper chain swallows Ctrl+C — use `POST /dev/shutdown` instead (NODE_ENV-gated). Production (Linux/Fly.io) drains via SIGTERM normally.
- **Phase 8 (sub-phase B) — vulnerable spool-up + transit (Limbo RETIRED in Phase 5/WS-B, 2026-06-14)**: **The `LimboStore` is DELETED.** Reconnect/restore state now lives on the ROSTER (`PlayerShipStore`): on disconnect `RosterPersistence.markLinger` freezes the row (the in-world hull also persists via `lingeringHulls[]` in the sector snapshot); on transit `TransitOrchestrator.commitTransit` `markStored`'s the roster row at the destination sector + threads the shipId through `reserveSeatFor`, so the destination `onJoin` **shipId-restore is the single path for BOTH reconnect and transit-arrival**. The `LIMBO_PUT`/`LIMBO_DELETE`/`LIMBO_GET` ops are gone; the `limbo` SQLite table + a one-release `limbo`→roster backfill (`initPlayerShipStore`) survive one release then drop; `/dev/limbo` is a back-compat stub (`{ exists: false }`). The disconnect "TTL" is now the roster `expiresAt`, which is **unenforced (no prune sweep)** ⇒ a lingering hull persists forever (R2.26) until combat / respawn-evict / abandon→wreck. Locks: `TransitOrchestrator.test.ts` (roster re-home on commit), the `lingering*`/`transit*`/`abandon*`/`spiral-disconnect-reconnect` suites. _Historical (now removed):_ `LimboStore` was an in-memory `Map<playerId, LimboEntry>` shadowed through `persistence.enqueueCritical` (`LIMBO_PUT`, `LIMBO_DELETE`). Two TTLs from the same store: **15 min disconnect** (`LIMBO_DISCONNECT_TTL_MS`) for held ship state across reconnects, **30 s transit-in-flight** (`LIMBO_TRANSIT_TTL_MS`) for the brief window between source-room `onLeave` and destination-room `onJoin`. `initLimboStore()` (called from `index.ts` after `initWorker`) hydrates from `SELECT ... WHERE expires_at > now` and starts a 30-s prune timer; the timer is `unref`'d so it doesn't keep the process alive. `TransitOrchestrator` ([transit/TransitOrchestrator.ts](../../src/server/transit/TransitOrchestrator.ts)) is mounted per-`SectorRoom`; the source room handles `engage_transit`/`cancel_transit` Colyseus messages, the orchestrator drives a per-player `TransitStateMachine` (pure, in [src/core/transit/](../../src/core/transit/TransitStateMachine.ts)). **Vulnerable spool-up**: ship stays in the source room during the 30-s spool (`SPOOL_DURATION_MS`, 10× the original 3 s — slow-down-gameplay pass 2026-05-18), fully damageable; orchestrator subscribes to `SHIP_DESTROYED` filtered by playerId and aborts on hit. On commit it reads SAB pose (NOT Colyseus schema — SAB is the 60 Hz ground truth), writes Limbo with the destination `sectorKey`, calls `matchMaker.reserveSeatFor` for `galaxy-${target}`, sets `playerToTransitInFlight` so the impending `onLeave` skips its own put, and sends `transit_state IN_TRANSIT` + `transit_ready { reservation }`. The destination room's `onJoin` consumes the entry via `LimboStore.take` if `payload.sectorKey === this.sectorKey` and restores `(x, y, vx, vy, angle, angvel, health, lastFireClientTick)` exactly. Engineering rooms (`sectorKey === null`) opt out of the whole flow — Limbo and transit are galaxy-only. `setSeatReservationTime(15)` is set explicitly in `onCreate` to lock the 15 s reservation TTL (default in 0.16 but explicit guards against future Colyseus default changes). `GET /dev/limbo?playerId=` exposes `{ exists, sectorKey, expiresAt }` for E2E inspection (no payload — avoids leaking pose). Shutdown drain calls `limboStore.stopPruneTimer()` first, then `persistence.shutdown` (the persistence shadow already mirrored every Limbo mutation through CRITICAL, so the existing drain handles them). See [docs/architecture/persistence-and-migrations.md](persistence-and-migrations.md) for the persistence layer.

- **Phase 2 multi-ship roster (foundation, in progress)**: `PlayerShipStore` ([src/server/playerShips/PlayerShipStore.ts](../../src/server/playerShips/PlayerShipStore.ts)) holds a player's persistent ship roster — an unlimited number of entries per player (anti-abuse `ROSTER_SOFT_GUARD = 200`), each with its own `ship_id` (UUID), `kind`, `health`, last-known pose, and `last_sector_key`. Backed by the new `player_ships` table; hot path is in-memory, every mutation shadows through `PLAYER_SHIP_PUT` / `PLAYER_SHIP_DELETE` on the CRITICAL lane. Unlike `LimboStore`, the roster has **no TTL** — entries live indefinitely until explicit abandon. Boot hydration is `initPlayerShipStore()` in `index.ts` after `initLimboStore()` (sequential — read-only `db` is shared). `/dev/player-ships?playerId=` returns the player's roster as JSON for the client landing screen, mirroring `/dev/limbo`'s shape. **Phase 2 only adds the table + store + read endpoint; gameplay still uses `LimboStore` for spawn/transit binding. Phase 3 wires the SectorRoom and TransitOrchestrator to use `PlayerShipStore` and drops `LimboStore`.** The catalogue-version drift safety is `applyKindVersionDrift` — stored rows have a `kindVersion`, and at hydrate any row whose version is below `SHIP_KIND_CATALOGUE_VERSION` ([src/shared-types/shipKinds.ts](../../src/shared-types/shipKinds.ts)) gets `health` clamped to the current kind's `maxHealth`. The id set is append-only (invariant #11) so `getShipKind(row.kind)` always resolves. Bumping rule: any PR that edits numeric fields inside `SHIP_KINDS` MUST bump `SHIP_KIND_CATALOGUE_VERSION` by 1 in the same PR. Mount-layout changes are out of scope for auto-migration — they require a separate story. Dev tool `scripts/clear-roster.mjs` is the companion to `clear-limbo.mjs` for smoke testing.

- **Structure persistence (Phase 5, 2026-06-14 — "structures lost after server reset" fix)**: placed structures now FULLY persist + reconstruct across a restart, inverting the persistence model toward a BLACKLIST (the world persists by default; only transient things are excluded). `SectorSnapshotPayload` gained a `structures[]` array carrying each structure's `owner / kind(subtype) / x / y / health / isConstructed / constructionProgress / minerals / storedPower` (position IS persisted — structures are player-placed, NOT seed-deterministic). `SectorPersistence.persist()` writes them from the `StructureRegistry`; `hydrate()` hands them to `SectorRoom.restoreStructuresFromSnapshot`, which re-places each via the SAME `structurePlacement.place` seam `seedStructureScenario` uses, restores the construction/minerals/power/health, and runs one `structureGridTick()` so the **connection web re-derives from the auto-connect sweep** (adjacency is NOT persisted). A fresh server mints new entity ids — nothing references the saved ids across a restart. The DB read/write is now INJECTED into `SectorPersistence` (`saveRow`/`loadRow`) so the persist↔hydrate round-trip is unit-testable. Lock: `SectorPersistence.structures.test.ts`.
  - **SCRAP persistence (v4, 2026-06-14)**: scrap (kind 3) now persists too. `SectorSnapshotPayload.scrap[]` carries each piece's drifted SAB pose + `parentShipKind` + `componentIndex` + health; the convex-hull collider is RE-DERIVED on hydrate from `(parentShipKind, componentIndex)` via the shared pure [`scrapColliderFor`](../../src/core/geometry/scrapCollider.ts) (the SAME mapping the death path + client use — so a restored scrap body is byte-identical; the collider is never on the wire NOR in the snapshot). `SectorRoom.scrapEntitiesForSnapshot` provides it; `restoreScrapFromSnapshot` reconstructs via `swarmSpawner.spawnScrap` + seeds health (restored scrap is NOT re-added to the `ScrapSpawner` FIFO — a bounded set; the slot pool still hard-caps). `CURRENT_SCHEMA_VERSION` bumped **3 → 4** (clean reseed). Lock: `scrapCollider.test.ts` + the scrap describe in `SectorPersistence.structures.test.ts`.
  - **LINGERING-HULL persistence (v5, 2026-06-14 — "lingers forever where you left it")**: a disconnected / fresh-spawn-displaced ship (`isActive=false`) now reappears IN-WORLD after a server restart, visible to others + reclaimable by the owner, until abandoned (→ wreck). `SectorSnapshotPayload.lingeringHulls[]` carries `{ shipInstanceId, playerId, kind, pose, health, shieldDown }`. **Design note: SECTOR-snapshot, not roster-scan** — `markActive` does NOT update `lastSectorKey` (only `create`/`markStored` do), so the roster's sector field is unreliable for in-world ships across a transit; the sector snapshot is keyed by the stable `sectorKey`. `SectorRoom.lingeringHullsForSnapshot` reads `lingeringSlots` + the schema + `lingeringPoseCache`; `restoreLingeringHullsFromSnapshot` (run during hydrate, BEFORE any onJoin) recreates the full disconnect-linger machine: a `new ShipState()` `isActive=false` entry + SAB pose + `linger-<shipInstanceId>` worker body (SPAWN + SET_POSITION) + `lingeringSlots`/`lingeringPoseCache`/`ownerlessShips=null`. `shipInstanceId` IS the roster `shipId` (the stable hull identity the REKEY + abandon→wreck paths rely on). **Gates:** skip if the roster row is gone (`getPlayerShipStore().get(id)===null` ⇒ abandoned ⇒ the wreck flow owns it), already-live, or `health<=0`. Safe vs the 30-tick abandon sweep (`findAbandonedShips` reaps only roster-DELETED ships, so a reconstructed hull with a live roster row is never reaped). The 10-ship cap was later removed (rosters are unlimited, `ROSTER_SOFT_GUARD = 200` anti-abuse); ships persist once spawned until abandoned. `CURRENT_SCHEMA_VERSION` **4 → 5**. Locks: the lingering describe in `SectorPersistence.structures.test.ts` (persist↔hydrate wiring) + `tests/integration/sectorRoom/lingeringReconstruct.test.ts` (real-room reconstruction + the abandoned-gate), with the existing `lingering*`/`abandon` locks green as the reproduce-first baseline. **Follow-up (Phase B): DONE (Phase 5/WS-B, 2026-06-14) — the 15-min `LIMBO_DISCONNECT_TTL_MS` AND the whole `LimboStore` are retired; reconnect/restore is roster-sourced. See the "Limbo RETIRED" bullet above.**
  - **The persistence model is OPT-OUT (blacklist), expressed as documented per-kind handling in `SectorPersistence.persist()`** (the mechanism differs per kind, so there is no single boolean gate): asteroids → swarm[] health; structures → `structures[]`; scrap → `scrap[]`; projectiles/missiles → never (ephemeral, not swarm entities). **DRONES (kind 1) are deliberately NOT in the sector snapshot — they are owned by the `LivingWorldDirector`, which is responsible for persisting + re-dispatching its squad pool itself (the user's directive: the director must "pick up and restart from any state" and direct the nearest roaming groups). This is NOT "ignoring drones" — it's a different persistence owner.** Follow-ups DONE (Phase 5): lingering hulls persist (v5), dynamic nearest-group dispatch (#68), **director-state persistence** (the director survives a restart — see the bullet below), and the **`LimboStore` retirement** (WS-B — disconnect + transit reservations both re-homed onto the roster).

### Server rules in full (moved from src/server/CLAUDE.md)

The zone `CLAUDE.md` keeps a condensed form of these rules; this is the full wording with its lock tests.

**Persistence and roster** ([persistence-and-migrations](../../docs/architecture/persistence-and-migrations.md)):
- The `dbWorker` is the sole DB writer; every write goes through `IPersistenceSink` (CRITICAL or VOLATILE lane); the main thread opens the DB read-only. On Windows dev, stop the server with `POST /dev/shutdown`.
- Reconnect and transit arrival both restore from the roster (`PlayerShipStore`) through the one `onJoin` shipId-restore path; there is no `LimboStore`. A lingering hull stays until combat, respawn-evict or abandon.
- Persistence is opt-out per kind in `SectorPersistence.persist()`: structures, scrap and lingering hulls persist; projectiles never; drones belong to the director. Re-derive adjacency and scrap colliders on hydrate; never key on entity ids across a restart.
- Bumping `CURRENT_SCHEMA_VERSION` tears down and reseeds every sector. New `player_ships` columns go through the idempotent `PLAYER_SHIPS_MIGRATIONS`; JSON columns parse defensively.
- A PR that edits numeric fields in `SHIP_KINDS` bumps `SHIP_KIND_CATALOGUE_VERSION` by 1; a mount-layout change needs its own migration story.
- Galaxy sectors are created eagerly at boot and simulate with no players; the broadcast loop skips an empty room.

