# Gameplay Audit Log

> A persistent, queryable record of discrete gameplay events — so questions
> like *"what happened to my base?"* can be answered after the fact, including
> events that fired while no player was connected.

## Why it exists

EQX Peri's world is alive while you're away. Galaxy sector rooms are eager-created
at boot and tick at 60 Hz with **zero players connected** (see `src/server/CLAUDE.md`
"Phase 8 sub-phase A" + "Drone warp-in / Equinox Phase 8"). The `WaveDirector`
dispatches drone squads at any *ready* base **regardless of owner presence**,
squads hop sector-to-sector, turrets defend, and structures take real
authoritative damage and get destroyed — all on a live tick the player never sees.

Before this feature, none of that was recoverable. Event signal lived only in
`pino` (stdout, ephemeral), the `serverLogEvent` ring (`src/server/debug/ServerEventLog.ts`
— 500 entries, dies on restart, dev-gated read), and sporadic client-initiated
diag captures. So when you logged back in to a smoking crater, there was no
durable record of who razed it.

The audit log fills that gap: a **rolling NDJSON file** of curated, semantic
events with enough context (timestamp, sector, owner, kind, attacker) to
reconstruct the story.

## What it is NOT

- **Not the diagnostic capture system** (`diag/captures/`) — that's client-driven,
  sporadic, perf-focused, and can't see server-only offline events.
- **Not a database** — by design (the request was explicitly "a simple logging
  file, not a DB"). It's append-only NDJSON written via `pino-roll`.
- **Not a per-tick stream.** It records DISCRETE events only (a destruction, a
  dispatch, a shield 0-cross, a join) — never positions/velocities/per-hit damage.
  "Under attack" is a *throttled* first-hit-in-window signal. This keeps it
  hot-loop-safe (root CLAUDE.md invariant #14) and keeps the log readable.

## Architecture

`src/server/audit/` — server-only, modelled on `ServerEventLog.ts` (a process-global
module singleton; import `auditEvent` from anywhere on the server, no DI):

| File | Role |
|---|---|
| `GameplayAuditLog.ts` | The `AuditEvent` discriminated union + `auditEvent()`; an in-memory ring (recent N, for `/dev/audit`); the durable `pino-roll` rolling-NDJSON sink (lazy); `setAuditSink()` test seam; `flushAudit()` for shutdown. |
| `auditQuery.ts` | **Pure** filter + one-line formatter over `AuditEvent[]`. Shared by the endpoint; unit-tested. |
| `auditFiles.ts` | Read the rolling NDJSON files back into `AuditEvent[]` (for `/dev/audit ?source=files\|all`). |
| `auditRoute.ts` | `GET /dev/audit` express handler (dev-gated). |

The **write path is NOT gated** — it runs in normal play (the whole point is to
capture offline events). Only the `/dev/audit` *read* endpoint is dev-gated
(like `/dev/events`, `/dev/population`). pino transports run in a `thread-stream`
worker, so file I/O is off the main thread.

**Under vitest**, `auditEvent` uses a no-op durable sink (the in-memory ring still
records) — no test spawns a worker or writes files unless it opts in via
`setAuditSink`.

### File location

Rolling daily NDJSON under `audit-logs/` (repo root; gitignored — local,
per-machine, churning, unlike `diag/`). pino-roll names files
`audit.<yyyy-MM-dd>.<n>.log` (the `.log` extension is pino-roll's default; the
content is NDJSON — the readers accept `.log` and `.ndjson`). Daily rotation,
20 MB size cap, 30-file retention. Override the dir with `EQX_AUDIT_DIR`.

Each line is one JSON object: pino's `{"level":30,...}` envelope (we keep `level`;
trying to strip it via a formatter emits invalid JSON) plus the event fields:

```json
{"level":30,"event":"structure_destroyed","sector":"sol-prime","owner":"<playerId>","kind":"capital","attackerId":"swarm-7","attackerKind":"drone","x":10,"y":20,"ts":1781691332689,"iso":"2026-06-17T10:15:32.689Z"}
```

## Event vocabulary

Every record carries `{ event, ts, iso, sector? }`. The `event` discriminator lets
the query layer include/exclude high-volume variants (e.g. drop `drone_destroyed`
to read just the base story).

| Category | Events |
|---|---|
| Base / living-world | `wave_dispatched` · `wave_incoming` · `base_ready` · `wave_repelled` |
| Structures | `structure_placed` · `structure_built` · `structure_removed` · `structure_attacked` (throttled) · `structure_destroyed` · `base_destroyed` (derived, Capital) |
| Combat / ships | `ship_destroyed` · `drone_destroyed` · `player_killed` (PvP) · `shield_broken` (player only) |
| Lifecycle | `player_joined` · `player_left` · `transit_started` · `ship_lingered` · `ship_abandoned` |

The exact per-variant fields are the discriminated union in
[`GameplayAuditLog.ts`](../../src/server/audit/GameplayAuditLog.ts).

### Attacker attribution

`attackerId` is the raw shooter id; `attackerKind` is a coarse label derived from
its prefix — `drone` (`swarm-`/`lwbot-`), `structure` (`pstruct-`), or `player`
(a bare UUID). The raw id is always present for precise forensics.

## Hook sites (where events are recorded)

All hooks are discrete, low-frequency boundaries — none in the per-tick pose/
broadcast path.

| Event(s) | Site |
|---|---|
| `structure_destroyed` / `base_destroyed` / `drone_destroyed` | `SectorRoom.evictSwarmEntity` (gated on `emitDestroyed` — real combat death; resolved BEFORE `structureRegistry.remove`) |
| `structure_attacked` | `SectorRoom.applyDamage` (throttled, 15 s/structure) |
| `structure_placed` / `structure_removed` | `place_structure` / `remove_structure` handlers |
| `structure_built` | `StructureGridSubsystem` `onConstructed` hook (1 Hz pulse) |
| `wave_dispatched` | `WaveDirector.assignReadyFactions` |
| `wave_incoming` | `IncomingRegistry.register` |
| `base_ready` | `SectorRoom.factionBaseReadiness` (one-shot) |
| `wave_repelled` | `LivingWorldDirector` retreat step |
| `ship_destroyed` / `player_killed` | `SectorRoom` `SHIP_DESTROYED` bus handler |
| `ship_abandoned` | `abandonShipToScrap` / `abandonLingeringHullToScrap` |
| `player_joined` | `SectorRoom.onJoin` |
| `player_left` / `ship_lingered` | `LeaveHandler` |
| `transit_started` | `TransitOrchestrator.commitTransit` |
| `shield_broken` | `ShieldHullRouter` (player path only) |

## Querying — "what happened to my base?"

### Offline (full history) — `scripts/query-audit.mjs`

Reads every NDJSON file under `audit-logs/` and prints a sorted, readable timeline.
Works with the server down. Also `pnpm audit:query -- <args>`.

```bash
node scripts/query-audit.mjs --sector=sol-prime --since=24h
node scripts/query-audit.mjs --player=<playerId> --event=structure_destroyed,base_destroyed
node scripts/query-audit.mjs --owner=<playerId> --json
```

- `--player` matches events INVOLVING the id (owner / playerId / attacker / victim).
- `--since` / `--until` accept epoch ms, an ISO date, or a relative duration
  (`30m` / `2h` / `7d` / `1w`).

Example output:

```
2026-06-17T03:11:00.000Z [sol-prime] wave_dispatched: wave of 8 → sol-prime (owner=abc, squad=squad-3)
2026-06-17T03:14:02.100Z [sol-prime] structure_attacked: capital owner=abc by swarm-7 (drone)
2026-06-17T03:14:55.700Z [sol-prime] structure_destroyed: capital owner=abc destroyed by swarm-7 (drone)
2026-06-17T03:14:55.700Z [sol-prime] base_destroyed: CAPITAL owner=abc destroyed by swarm-7
```

### Live (running server) — `GET /dev/audit`

Dev-gated; queries the durable history + the live in-memory ring tail.

```
GET /dev/audit?sector=sol-prime&event=structure_destroyed
GET /dev/audit?player=<id>&since=1h&format=text
```

Params: `player`, `owner`, `sector`, `event` (comma-separated), `since`, `until`,
`limit` (default 500), `source` (`ring`|`files`|`all`, default `all`), `format`
(`json`|`text`).

## Adding a new event

1. Append a variant to the `AuditEvent` union in `GameplayAuditLog.ts`.
2. Add a `case` to `formatAuditLine` in `auditQuery.ts` (and the mirrored switch
   in `scripts/query-audit.mjs`).
3. Call `auditEvent({ event: '…', … })` at the discrete boundary — never inside a
   per-tick / per-hit loop (throttle if the boundary can fire rapidly).
4. If the event references identities for the `--player` filter, ensure the field
   name is in `eventIdentities` (`auditQuery.ts`) + the script's `identities`.
