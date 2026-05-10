# CLAUDE.md — src/server (The Authority)

`src/server` is the absolute source of truth. The client runs prediction to hide latency, but the server's state is reality. Every piece of game logic runs here first, then gets broadcast. Read the root [CLAUDE.md](../../CLAUDE.md) for project-wide invariants before editing.

---

## Forbidden Imports (CI-enforced)

Never import from `src/server/`:

- UI / rendering: `pixi.js`, `pixi-viewport`, `react`, `react-dom`, `@mui/*`, `@emotion/*`, `howler`, `zustand`
- The client-side Colyseus package: `colyseus.js` (the server uses `colyseus`, not `colyseus.js`)
- Anything under `src/client/**`

Allowed: `colyseus`, `@colyseus/schema`, `@colyseus/ws-transport`, `express`, `zod`, `node:sqlite` (built-in, replaces `better-sqlite3` — see `docs/LESSONS.md` for why), `bcryptjs`, `jose`, `dotenv`, `pino` + `pino-pretty`, `src/core`, `src/shared-types`. Phase 9 may additionally allow `@colyseus/redis-driver` / `@colyseus/redis-presence` *iff* the multi-VM deployment shape is chosen.

---

## Authority Model

- Clients send **inputs**. The server decides **outcomes**. Never the other way around.
- Any state that matters is computed server-side. Client-side prediction (Phase 3) and ghost projectiles (Phase 4) are presentation tricks; they must never influence the authoritative state.
- The Colyseus `SectorRoom` owns one sector's physics world, AI, combat resolution, and broadcast path. Everything else (persistence, orchestration, galaxy registry) is a supporting service the room uses.

---

## Validation Contract (zod at the boundary)

- **Every** inbound message has a zod schema in `src/shared-types/`.
- Parse every message in `onMessage`. On failure: drop silently, increment a per-connection error counter, sampled `pino.warn`. Never throw to the game loop.
- Keep schemas strict (`.strict()`), no unknown keys.

---

## Thresholds (fill in as phases land)

Phase 0: placeholder. These tighten as each phase ships:

- **Phase 3 — snapshot broadcast rate**: pre-Stage-5: 20 Hz global. Stage 5 initial (REVERTED): tried 30 Hz close-tier + 20 Hz far-tier with per-client phase offsets, but the union of two cadences produced irregular 17/17/33/33 ms intervals at the recipient — see hotfix #4 in `docs/LESSONS.md`. Stage 5 post-hotfix #4: single 20 Hz cadence (`shouldBroadcastFar` only) with per-client phase offset hashed from playerId so recipients almost never peak on the same tick (smooths server CPU). Idle sectors (no motion-above-epsilon AND no projectiles in flight for `IDLE_THRESHOLD_TICKS = 60` consecutive ticks) suppress broadcasts entirely. `lastInput` field omitted when bits match the per-recipient cache. Scheduling tick is `broadcastCounter` (main-thread, once-per-`update()`), NOT `serverTick` (SAB-read; advances unevenly under main/worker drift). See `docs/architecture/snapshot-cadence.md`. Tier classification helpers in `snapshotScheduler.ts` (`classifyShipTier`, `createTierState`) are unit-tested but unused in production after hotfix #4 — preserved for a future single-cadence-with-tier-inclusion design (Stage 5b).
- **Phase 4 — micro rate limit**: max 3 inputs per entity per tick in `onMessage`. Excess silently dropped.
- **Phase 4 — temporal plausibility**: hit claims older than 12 ticks (~200 ms) rejected.
- **Phase 4 — backpressure**: `ws.bufferedAmount > 50 KB` drops oldest queued snapshot; `> 250 KB` force-closes the socket.
- **Phase 4 — lag-comp buffer**: pre-allocated 1000 entities × 12 ticks × 16 bytes = 192 KB per sector. No per-tick allocation.
- **Phase 5d — interest grid**: `SpatialGrid` (2048-unit cells). Each client receives entities in its 3×3 cell window at full fidelity; out-of-interest entities are still shipped every 6 ticks (decimation cadence). Cell move per entity per tick is cheap because most entities don't cross a 2048 u boundary in a single 16.67 ms step.
- **Phase 5d — wire format**: encoder is per-client, called from `SectorRoom.update()` inside the existing per-client backpressure loop. `BinarySwarmBroadcast.encode(registry, sab, sab, tick, inInterest?)` — when `inInterest` is undefined the encoder behaves like Phase 5c (broadcast-all), so unit tests that pre-date 5d still pass unmodified.
- **Wire format v3 (2026-05-09 AI lockstep)**: `SWARM_WIRE_VERSION = 3`. Per-record stride 33 bytes (was 29 in v2). Adds `f32 angvel` at offset +24 between `angle` and `radius`; shifts `radius` to +28 and `shipKind` to +32. Decoder hard-fails on `version !== 3` (no fallback). `SwarmEntityRegistry.poseChanged` now considers `|Δω| > 0.05 rad/s` as a delta-shipping trigger so spinning drones generate fresh packets even when stationary. `BinarySwarmBroadcast` zeroes `angvel` on SLEEPING records (parity with vx/vy). The field is required for client-side AI lockstep — without it the AI's `1.5·ω` damping term diverged between sides every tick. See [docs/architecture/ai-lockstep.md](../../docs/architecture/ai-lockstep.md).
- **Drone snapshot slice (Phase C, 2026-05-09)**: `SnapshotMessage.drones?: Array<{ id, x, y, vx, vy, angle, angvel }>` ships the in-interest drone subset at `snap.serverTick`, sourced from `SnapshotRing.getPoseAt(id, serverTick)` so the poses are temporally aligned with `snap.states`. The client uses these to seed predWorld drone bodies before reconciler replay — the snapshot becomes the single source of truth for in-interest drones, and the binary swarm packet's `setShipState` is gated off for those drones to prevent dual-correction-path fighting. `SnapshotRing` extended from 5 to 6 floats per slot (480 KB → 576 KB per sector) to carry angvel through the lag-comp ring. Per-recipient interest reuses the `interestScratch` set already built by the swarm-broadcast block earlier in `update()` — no extra `query9` call.
- **Phase 6 — TiDi**: `SimulationClock` reports `totalMs` once per `update()`. Constants in `src/core/clock/SimulationClock.ts`: `OVER_BUDGET_MS = 14`, `WINDOW_TICKS = 30`, `RAMP_PER_TICK = 0.005` (1 s ramp from 1.0 → 0.7), hard `FLOOR = 0.7`. The room mirrors `clock.rate` to `state.clockRate` (Colyseus schema diff broadcasts to clients) and posts a `CLOCK_RATE` worker command only when the rate moves at least 1e-4 — keeps the worker queue clean. Single-writer rule: only the worker writes `CLOCK_RATE_IDX` in the SAB header; the server's only path to mutate it is the `CLOCK_RATE` postMessage.
- **Phase 6 — LoadShedder**: lives at `src/server/orchestration/LoadShedder.ts`. Fires when `rate ≤ TIDI_FLOOR + 0.01` (0.71) AND `busiestMs > OVER_BUDGET_MS` (14), where `busiestMs = Math.max(serverTotalMs, workerTickMs)`. Selects farthest-from-closest-player drones (kind=1 only — asteroids are immune); batch = `Math.min(8, Math.ceil(droneCount * 0.10))` per tick. Despawns quietly via `evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false })` — no `'destroy'` broadcast, no `ENTITY_DESTROYED`, so the kill-feed and explosion SFX (when Phase 4 ships them) don't fire on player-invisible cleanup. Emits the new `ENTITY_SHED` bus variant for persistence/telemetry.
- **Phase 7 — SQLite persistence (shipped)**: WAL + `synchronous=NORMAL`. The `dbWorker` (`src/server/db/dbWorker.ts`) is the **sole writer**, spawned via `bundleWorker` at server startup from `src/server/index.ts:main()`. Two priority lanes through `IPersistenceSink` (`src/core/contracts/IPersistenceSink.ts`):
  - **CRITICAL** — coalesced through a 50 ms write-ahead buffer in `WorkerBackedSink`, flushed as one `BATCH` postMessage per window, applied inside a `BEGIN`/`COMMIT` transaction. WAB cap 10 000 ops force-flushes synchronously on overrun. `enqueueCriticalAwaitable` exists for callers that need the rowid back synchronously (auth `register` only); 2 s timeout.
  - **VOLATILE** — fire-and-forget telemetry (Phase 6 `ENTITY_SHED`, sleep transitions, sampled `LASER_FIRED`). Drains immediately when the worker is alive; buffered up to 5 000 with oldest-drop while the worker is unavailable.
  Auth keeps a **read-only** main-thread `DatabaseSync` (lazy-opened in `Database.ts`) for `SELECT` paths; all writes flow through the sink. `recordGameJoin`/`recordGameLeave` correlate via `play_id` (no rowid round-trip). SIGINT/SIGTERM in `index.ts` await `persistence.shutdown({ timeoutMs: 8000 })` then `gameServer.gracefullyShutdown()`. On Windows dev, the `pnpm dev:server` wrapper chain swallows Ctrl+C — use `POST /dev/shutdown` instead (NODE_ENV-gated). Production (Linux/Fly.io) drains via SIGTERM normally.
- **Phase 8 (sub-phase B — shipped) — Limbo + vulnerable spool-up + transit**: `LimboStore` ([src/server/limbo/LimboStore.ts](limbo/LimboStore.ts)) is an in-memory `Map<playerId, LimboEntry>` shadowed through `persistence.enqueueCritical` (`LIMBO_PUT`, `LIMBO_DELETE`). Two TTLs from the same store: **5 min disconnect** (`LIMBO_DISCONNECT_TTL_MS`) for held ship state across reconnects, **30 s transit-in-flight** (`LIMBO_TRANSIT_TTL_MS`) for the brief window between source-room `onLeave` and destination-room `onJoin`. `initLimboStore()` (called from `index.ts` after `initWorker`) hydrates from `SELECT ... WHERE expires_at > now` and starts a 30-s prune timer; the timer is `unref`'d so it doesn't keep the process alive. `TransitOrchestrator` ([transit/TransitOrchestrator.ts](transit/TransitOrchestrator.ts)) is mounted per-`SectorRoom`; the source room handles `engage_transit`/`cancel_transit` Colyseus messages, the orchestrator drives a per-player `TransitStateMachine` (pure, in [src/core/transit/](../core/transit/TransitStateMachine.ts)). **Vulnerable spool-up**: ship stays in the source room during the 3-s spool, fully damageable; orchestrator subscribes to `SHIP_DESTROYED` filtered by playerId and aborts on hit. On commit it reads SAB pose (NOT Colyseus schema — SAB is the 60 Hz ground truth), writes Limbo with the destination `sectorKey`, calls `matchMaker.reserveSeatFor` for `galaxy-${target}`, sets `playerToTransitInFlight` so the impending `onLeave` skips its own put, and sends `transit_state IN_TRANSIT` + `transit_ready { reservation }`. The destination room's `onJoin` consumes the entry via `LimboStore.take` if `payload.sectorKey === this.sectorKey` and restores `(x, y, vx, vy, angle, angvel, health, lastFireClientTick)` exactly. Engineering rooms (`sectorKey === null`) opt out of the whole flow — Limbo and transit are galaxy-only. `setSeatReservationTime(15)` is set explicitly in `onCreate` to lock the 15 s reservation TTL (default in 0.16 but explicit guards against future Colyseus default changes). `GET /dev/limbo?playerId=` exposes `{ exists, sectorKey, expiresAt }` for E2E inspection (no payload — avoids leaking pose). Shutdown drain calls `limboStore.stopPruneTimer()` first, then `persistence.shutdown` (the persistence shadow already mirrored every Limbo mutation through CRITICAL, so the existing drain handles them). See [docs/architecture/persistence-and-migrations.md](../../docs/architecture/persistence-and-migrations.md) for the persistence layer.

- **Configurable arrival (2026-05-10)**: `EngageTransitSchema` carries an optional, strict `arrival: { x: finite, y: finite }` (`src/shared-types/messages.ts`). When present, `TransitOrchestrator.beginTransit(playerId, target, arrival?)` stashes it on the in-flight record; `commitTransit` writes the LimboPayload's `x/y` from `clampToSectorBounds(arrival.x, arrival.y)` instead of the SAB pose. Velocity, angle, and angvel are **always** SAB — only the landing point is overridable. Bounds: `SECTOR_PLAYABLE_HALF_EXTENT = 5000` in `src/shared-types/sectorBounds.ts`, shared with the client. Server clamp is defense-in-depth; the client also clamps on input blur. Absent `arrival` ⇒ legacy SAB-pose path (regression-locked in `TransitOrchestrator.test.ts`). See [docs/features/configurable-arrival.md](../../docs/features/configurable-arrival.md).

- **Phase 8 (sub-phase A — shipped) — Persistent galaxy substrate**: 7-sector hexagonal sunflower defined in [src/core/galaxy/galaxy.ts](../core/galaxy/galaxy.ts) (Sol Prime centre + 6 outers). Each galaxy sector is registered as `gameServer.define('galaxy-${key}', SectorRoom, { sectorKey, ... })` and **eagerly created** at boot via `matchMaker.createRoom` (see [src/server/index.ts](index.ts) `main()`), so they hydrate from snapshots before any traveller arrives and so future seat reservations always land on a live room. Engineering rooms (`sector`, `test-sector`, `swarm-soak`, `swarm-tidi`, `swarm-tidi-burn`) keep `sectorKey === null`, lazy-create on first join, and have no persistent identity. Galaxy `SectorRoom`s persist swarm health every 60 s (and on `onDispose`) via the dormant-since-Phase-7 `saveSnapshot` op now activated, keyed by `sectorKey` not `roomId`. Hydration on `onCreate` reads the most recent row from `game_snapshots`, validates `schemaVersion === CURRENT_SCHEMA_VERSION` (mismatch ⇒ silent fresh-spawn), and discards rows older than 24 h. Bumping `CURRENT_SCHEMA_VERSION` in [src/server/rooms/SectorSnapshot.ts](rooms/SectorSnapshot.ts) is the canonical "tear down all sectors and reseed" knob. Galaxy sectors run the simulation step regardless of player count (so the world feels alive when empty); the broadcast loop short-circuits when `clients.length === 0`. See [docs/architecture/galaxy-graph.md](../../docs/architecture/galaxy-graph.md) and [docs/architecture/persistence-and-migrations.md](../../docs/architecture/persistence-and-migrations.md). Sub-phase B layers Limbo (5 min disconnect TTL, 30 s transit-in-flight) and 15-second `setSeatReservationTime` for inter-sector hyperspace transit on top.

Update this section when a threshold is set.

---

## Pino Sampling Policy

- Dev: `pino-pretty` transport.
- Prod: JSON to stdout (Fly.io captures).
- High-frequency events (`LASER_FIRED`, `ENTITY_WOKE` storms, reconciliation drifts): sample at **1 %**.
- Discrete lifecycle events (join/leave, transit state changes, sector spin-up/-down): **full fidelity**.
- Never log position/velocity data.

---

## Combat Architecture (Phase 4)

- **SnapshotRing** (`src/server/lagcomp/SnapshotRing.ts`): pre-allocated Float32Array ring buffer (1000 × 12 × 16 bytes = 192 KB). `record(tick, entities)` called every `update()`; `getAt(entityId, tick)` returns rewound position for lag-comp. No per-tick allocation.
- **Lag-comp hit resolution**: uses the pure-geometry `rayHitsSphere()` from `src/core/combat/Weapons.ts` against SnapshotRing positions — NOT Rapier's `castRay`. The server main thread does not have a live Rapier world (physics lives in the worker).
- **Projectile simulation**: Euler integration in `advanceProjectiles()` on the main thread, not in the physics worker. Lifetime limit: 180 ticks (3 s). Circle-circle collision detection per-tick against each live ship.
- **Backpressure** (`src/server/net/Backpressure.ts`): `checkBackpressure(client, logger)` returns `'ok' | 'drop' | 'close'`. Called in the per-client broadcast loop in `update()`.
- **Weapon cooldown enforcement**: `lastFireTick` map, compared against `WEAPON_COOLDOWN_TICKS = 10` (167 ms at 60 Hz). Excess fire requests return `hit: false` immediately.
- **Temporal plausibility**: fire claims with `tick < serverTick - 12` are rejected before any lag-comp lookup.
- **Weapon catalogue (data-driven)**: `handleFire()` resolves `weaponDef = getWeapon(weaponId)` from `src/core/combat/WeaponCatalogue.ts` and branches on `weaponDef.mode`. Hitscan reads `range`/`damage` from the def; projectile passes `damage`, `radius`, `maxTicks`, `weaponId` into `spawnServerProjectile`. Each `ProjectileRecord` carries its own `damage`/`radius`/`maxTicks` — `advanceProjectiles()` reads them off the record, never off a global constant. **Adding a new weapon never requires editing `SectorRoom.ts`** — only the catalogue.
- **Projectile vs swarm collision**: `advanceProjectiles()` runs two collision passes per projectile per tick — first against player ships (lag-comp via SnapshotRing — currently the spawn tick's SAB pose for projectiles), then against swarm entities via `swarmRegistry.all()` reading current SAB pose. The swarm pass is required: solo play has only drones/asteroids as targets, so a missing swarm loop = "lasers sail through everything." Hit position (`hitX`, `hitY`) is threaded into `applyDamage()` and broadcast in `DamageEvent` for the client damage-numbers/health-bars pipeline.

---

## Threading

- Phase 2 evicts Rapier to a `worker_threads` worker; the main Colyseus thread reads SAB directly.
- Phase 7 (shipped) moves `node:sqlite` writes to a dedicated `worker_threads` worker via the same `bundleWorker` esbuild helper used by the physics worker. The main thread holds only a **read-only** `DatabaseSync` for auth `SELECT`s.
- If you are adding a new CPU-heavy subsystem, default to spawning a worker rather than running on the main thread.
