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
- **Phase 4 — temporal plausibility**: fire claims older than `LAG_COMP_WINDOW` (12 ticks, ~200 ms) are **clamped** to the window floor and resolved against the oldest SnapshotRing pose — NOT rejected (changed 2026-05-19, capture `uf0o8g`: hard-rejecting dropped ~37% of a laggy client's shots when its wall-clock-anchored `inputTick` fell behind `serverTick` after a stall). Rewind stays bounded by `LAG_COMP_WINDOW` (no abuse advantage); the per-shooter cooldown is the separate, unchanged anti-rapid-fire guard. Pure helper: `clampFireTick` (`src/core/combat/fireTemporal.ts`).
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
- **Phase 8 (sub-phase B — shipped) — Limbo + vulnerable spool-up + transit**: `LimboStore` ([src/server/limbo/LimboStore.ts](limbo/LimboStore.ts)) is an in-memory `Map<playerId, LimboEntry>` shadowed through `persistence.enqueueCritical` (`LIMBO_PUT`, `LIMBO_DELETE`). Two TTLs from the same store: **15 min disconnect** (`LIMBO_DISCONNECT_TTL_MS`) for held ship state across reconnects, **30 s transit-in-flight** (`LIMBO_TRANSIT_TTL_MS`) for the brief window between source-room `onLeave` and destination-room `onJoin`. `initLimboStore()` (called from `index.ts` after `initWorker`) hydrates from `SELECT ... WHERE expires_at > now` and starts a 30-s prune timer; the timer is `unref`'d so it doesn't keep the process alive. `TransitOrchestrator` ([transit/TransitOrchestrator.ts](transit/TransitOrchestrator.ts)) is mounted per-`SectorRoom`; the source room handles `engage_transit`/`cancel_transit` Colyseus messages, the orchestrator drives a per-player `TransitStateMachine` (pure, in [src/core/transit/](../core/transit/TransitStateMachine.ts)). **Vulnerable spool-up**: ship stays in the source room during the 30-s spool (`SPOOL_DURATION_MS`, 10× the original 3 s — slow-down-gameplay pass 2026-05-18), fully damageable; orchestrator subscribes to `SHIP_DESTROYED` filtered by playerId and aborts on hit. On commit it reads SAB pose (NOT Colyseus schema — SAB is the 60 Hz ground truth), writes Limbo with the destination `sectorKey`, calls `matchMaker.reserveSeatFor` for `galaxy-${target}`, sets `playerToTransitInFlight` so the impending `onLeave` skips its own put, and sends `transit_state IN_TRANSIT` + `transit_ready { reservation }`. The destination room's `onJoin` consumes the entry via `LimboStore.take` if `payload.sectorKey === this.sectorKey` and restores `(x, y, vx, vy, angle, angvel, health, lastFireClientTick)` exactly. Engineering rooms (`sectorKey === null`) opt out of the whole flow — Limbo and transit are galaxy-only. `setSeatReservationTime(15)` is set explicitly in `onCreate` to lock the 15 s reservation TTL (default in 0.16 but explicit guards against future Colyseus default changes). `GET /dev/limbo?playerId=` exposes `{ exists, sectorKey, expiresAt }` for E2E inspection (no payload — avoids leaking pose). Shutdown drain calls `limboStore.stopPruneTimer()` first, then `persistence.shutdown` (the persistence shadow already mirrored every Limbo mutation through CRITICAL, so the existing drain handles them). See [docs/architecture/persistence-and-migrations.md](../../docs/architecture/persistence-and-migrations.md) for the persistence layer.

- **Phase 2 multi-ship roster (foundation, in progress)**: `PlayerShipStore` ([src/server/playerShips/PlayerShipStore.ts](playerShips/PlayerShipStore.ts)) holds a player's persistent ship roster — up to `ROSTER_CAP = 10` entries per player, each with its own `ship_id` (UUID), `kind`, `health`, last-known pose, and `last_sector_key`. Backed by the new `player_ships` table; hot path is in-memory, every mutation shadows through `PLAYER_SHIP_PUT` / `PLAYER_SHIP_DELETE` on the CRITICAL lane. Unlike `LimboStore`, the roster has **no TTL** — entries live indefinitely until 10-cap eviction (Phase 3) or explicit abandon. Boot hydration is `initPlayerShipStore()` in `index.ts` after `initLimboStore()` (sequential — read-only `db` is shared). `/dev/player-ships?playerId=` returns the player's roster as JSON for the client landing screen, mirroring `/dev/limbo`'s shape. **Phase 2 only adds the table + store + read endpoint; gameplay still uses `LimboStore` for spawn/transit binding. Phase 3 wires the SectorRoom and TransitOrchestrator to use `PlayerShipStore` and drops `LimboStore`.** The catalogue-version drift safety is `applyKindVersionDrift` — stored rows have a `kindVersion`, and at hydrate any row whose version is below `SHIP_KIND_CATALOGUE_VERSION` ([src/shared-types/shipKinds.ts](../shared-types/shipKinds.ts)) gets `health` clamped to the current kind's `maxHealth`. The id set is append-only (invariant #11) so `getShipKind(row.kind)` always resolves. Bumping rule: any PR that edits numeric fields inside `SHIP_KINDS` MUST bump `SHIP_KIND_CATALOGUE_VERSION` by 1 in the same PR. Mount-layout changes are out of scope for auto-migration — they require a separate story. Dev tool `scripts/clear-roster.mjs` is the companion to `clear-limbo.mjs` for smoke testing.

- **Configurable arrival (2026-05-10)**: `EngageTransitSchema` carries an optional, strict `arrival: { x: finite, y: finite }` (`src/shared-types/messages.ts`). When present, `TransitOrchestrator.beginTransit(playerId, target, arrival?)` stashes it on the in-flight record; `commitTransit` writes the LimboPayload's `x/y` from `clampToSectorBounds(arrival.x, arrival.y)` instead of the SAB pose. Velocity, angle, and angvel are **always** SAB — only the landing point is overridable. Bounds: `SECTOR_PLAYABLE_HALF_EXTENT = 5000` in `src/shared-types/sectorBounds.ts`, shared with the client. Server clamp is defense-in-depth; the client also clamps on input blur. Absent `arrival` ⇒ legacy SAB-pose path (regression-locked in `TransitOrchestrator.test.ts`). See [docs/features/configurable-arrival.md](../../docs/features/configurable-arrival.md).

- **Phase 5 — in-game roster switching via transit (2026-05-13)**: `EngageTransitSchema` gains an optional `shipId: z.string().min(1)` field. When present, `TransitOrchestrator.beginTransit(playerId, target, arrival?, shipId?)` validates ownership via `playerShipStore.get(shipId).playerId === playerId` BEFORE spinning up the state machine — foreign / unknown ids reject with `destination_unavailable` (single load-bearing check that prevents ship-hijack via the wire). On commit the `shipId` is threaded through `reserveSeatFor` options to the destination room's `onJoin`, where the existing Phase 3 shipId-bind path (`JoinOptionsSchema.shipId`) hydrates the named roster row instead of the source ship's Limbo entry. The orchestrator's 4th constructor arg is the `PlayerShipStore`; omitting it makes any shipId-carrying request reject as unknown (safe-by-default). Absent `shipId` ⇒ legacy path (the source ship continues into the destination, exactly as Phase 8 sub-phase B). The CLIENT'S in-game spawn-from-roster does NOT use this path — it dispatches a `pendingShipSwap` Zustand intent that App.tsx executes as a direct leave-current-room + join-new-room cycle (loading spinner via 'connecting' phase). The transit-orchestrator shipId path is kept as a future seam (server-side validated; not invoked by current UI).

- **Phase 6a foundation — shipInstanceId on the wire + isActive flag (2026-05-13)**: `WelcomeMessage.shipInstanceId` (already shipped in Phase 5) and `SnapshotMessage.states[shipInstanceId]` (new — keyed by shipInstanceId, each entry carries `playerId` + `isActive`) form the wire-level identity for "which hull is this". The Colyseus `SectorState.ships` MapSchema **stays keyed by playerId in 6a** (Option A) — the one-active-hull-per-player invariant still holds, so the ~25 internal `state.ships.get(playerId)` callsites don't need a mechanical rekey yet. Phase 6b flips the schema key when lingering hulls actually require >1 entry per player. `playerToActiveShipInstance: Map<playerId, shipInstanceId>` is the indirection map populated on spawn and cleared on leave/eviction/wreck-conversion; `resolveActiveShipKey(playerId)` is the canonical lookup helper. Engineering rooms (`sectorKey === null`) generate a synthetic `randomUUID()` for `ship.shipInstanceId` at join time so the wire key + downstream lookups are never empty. `ShipState.isActive` is always true in 6a; Phase 6b sets it false for lingering hulls so the client's snapshot translator can gate visibility. Client side (C-ii strategy): `ColyseusClient.handleSnapshot` translates the shipInstanceId-keyed wire format to a playerId-keyed local view at ingest, skipping `isActive=false` entries. Internal mirror / predWorld / reconciler keys remain playerId so no render-code change is needed. Tests: `SectorRoom.shipKey.test.ts` locks the helper; `messages.test.ts` "Phase 6a wire shape" describe locks the wire contract.

- **Phase 8 (sub-phase A — shipped) — Persistent galaxy substrate**: 7-sector hexagonal sunflower defined in [src/core/galaxy/galaxy.ts](../core/galaxy/galaxy.ts) (Sol Prime centre + 6 outers). Each galaxy sector is registered as `gameServer.define('galaxy-${key}', SectorRoom, { sectorKey, ... })` and **eagerly created** at boot via `matchMaker.createRoom` (see [src/server/index.ts](index.ts) `main()`), so they hydrate from snapshots before any traveller arrives and so future seat reservations always land on a live room. Engineering rooms (`sector`, `test-sector`, `swarm-soak`, `swarm-tidi`, `swarm-tidi-burn`) keep `sectorKey === null`, lazy-create on first join, and have no persistent identity. Galaxy `SectorRoom`s persist swarm health every 60 s (and on `onDispose`) via the dormant-since-Phase-7 `saveSnapshot` op now activated, keyed by `sectorKey` not `roomId`. Hydration on `onCreate` reads the most recent row from `game_snapshots`, validates `schemaVersion === CURRENT_SCHEMA_VERSION` (mismatch ⇒ silent fresh-spawn), and discards rows older than 24 h. Bumping `CURRENT_SCHEMA_VERSION` in [src/server/rooms/SectorSnapshot.ts](rooms/SectorSnapshot.ts) is the canonical "tear down all sectors and reseed" knob. Galaxy sectors run the simulation step regardless of player count (so the world feels alive when empty); the broadcast loop short-circuits when `clients.length === 0`. See [docs/architecture/galaxy-graph.md](../../docs/architecture/galaxy-graph.md) and [docs/architecture/persistence-and-migrations.md](../../docs/architecture/persistence-and-migrations.md). Sub-phase B layers Limbo (15 min disconnect TTL, 30 s transit-in-flight) and 15-second `setSeatReservationTime` for inter-sector hyperspace transit on top.

- **Warp/transit join-broadcast grace (2026-05-15)**: `JOIN_BROADCAST_GRACE_TICKS = 300` (5 s @ 60 Hz, [rooms/SectorRoom.ts](rooms/SectorRoom.ts)). On every join / spawn / reconnect-rebind the room sets `forceBroadcastUntilTick = currentTick + JOIN_BROADCAST_GRACE_TICKS`; while `serverTick < forceBroadcastUntilTick` the broadcast gate treats the sector as non-idle **regardless of motion** (`inJoinGrace` short-circuits `isSectorIdle`), so a just-joined stationary client gets the steady snapshot stream it needs to reconcile its prediction. Without it, Stage-5 idle-suppression starved a freshly-spawned stationary ship of snapshots until the player moved — then the first snapshot snapped the stale free-run prediction hundreds of units (the "warp / change-sector → stay still → move → teleport" smoke-test bug, diag 2026-05-15). 5 s deliberately matches the client's `joinMinimumElapsed` warp-curtain floor so the first correction lands *beneath* the curtain. Companion `warp_in` / `warp_out` broadcasts (`TransitOrchestrator` / `SectorRoom` → [src/shared-types/messages.ts](../shared-types/messages.ts)) drive remote-ship warp visuals. Locked by [tests/integration/sectorRoom/joinBroadcastGrace.test.ts](../../tests/integration/sectorRoom/joinBroadcastGrace.test.ts) + [warpBroadcasts.test.ts](../../tests/integration/sectorRoom/warpBroadcasts.test.ts). Full feature story: [docs/architecture/warp-visual.md](../../docs/architecture/warp-visual.md).

- **Living World Director (2026-05-16)**: process-global `LivingWorldDirector` ([src/server/livingworld/](livingworld/)) owns a fixed pool of `LIVING_WORLD_BOT_COUNT = 25` hunter bots (`lwbot-*`), constructed in [index.ts](index.ts) `main()` AFTER the eager `matchMaker.createRoom(galaxy-*)` loop (it captures those `SectorRoom` instances) and `stop()`'d in `shutdown()` alongside the Limbo prune timer. unref'd ~1.5 s control loop (population/routing is discrete low-frequency logic — NOT a physics-tick concern). Defaults: `controlIntervalMs 1500`, `respawnDelayMs 12_000`, `arrivalCooldownMs 5_000`, `maxMigrationsPerTick 4`, `shedRecoveryMs 10_000`, `initialStaggerMs 200`, `playerStickyMs 30_000`, `spoolMs = SPOOL_DURATION_MS` — all constructor options (tests inject tiny values + a seeded RNG). **Occupancy hysteresis (`playerStickyMs`, diag 2026-05-16 `q272do`):** a sector that had a live player within the window still counts as occupied when the director builds the `playerCounts` it feeds `computeDesiredDistribution`, so a mobile client's disconnect→reconnect flap (which drops `playerCount()` to 0 for a few seconds — lingering hull is `isActive=false`) can NOT whipsaw the desired distribution between "all bots to the player" and "even 7-way spread" and mass-churn the whole pack through the player's sector every ~1.5 s control tick (the periodic warp "bumps" the player felt). Mirrors the `arrivalCooldownMs`/`shedRecoveryMs` anti-flap philosophy on the occupancy axis. The step-3 hostility check still reads the **live** `playerCount()`, so bots stand down the instant a player truly leaves — only bot *placement* is damped. Single owner of bot lifecycle; the `BotRecord` state machine (`active`/`in-transit`/`respawning`) is guarded + idempotent so kill/shed/emergency/transit-outcome signals converge, never race (a lifecycle bus event wins over a transit outcome). Bots are server-internal swarm entities (NOT Colyseus clients) — the cross-room hop is a `BotTransitController` (the *pure* `TransitStateMachine`, NOT a `TransitOrchestrator` fork) + the thin `SectorRoom` hooks `spawnLivingWorldBot` / `despawnLivingWorldBot` / `markBotHostile` / `playerCount` / `hasFreeSlot` / `eventBus`. Quiet inter-sector despawn reuses the LoadShedder path `evictSwarmEntity{broadcast:false,emitDestroyed:false}` — it MUST NOT emit `ENTITY_DESTROYED` (that bus event is the director's respawn trigger). Hunting is the *existing* `markHostile` channel + one discrete `bot_aggro` broadcast (server→client twin of the `damage`→`markHostile` mirror) — **do NOT add a `proactive` `HostileDroneBehaviour` branch or a swarm-wire flag** (see `src/core/CLAUDE.md` AI-lockstep section + [docs/architecture/living-world.md](../../docs/architecture/living-world.md)). Ambient patrol floor is `AMBIENT_DRONE_FLOOR = 2` per galaxy sector ([src/core/galaxy/galaxy.ts](../core/galaxy/galaxy.ts)); the 25 hunters are additive. Observability: `GET /dev/population` (NODE_ENV-gated) + the new `population` diag bucket (`bot_spawn`/`bot_despawn`/`bot_transit_start|commit|cancel`/`bot_respawn`/`population_report`). Locks: `population.test.ts`, `BotTransitController.test.ts`, `tests/integration/sectorRoom/livingWorldHooks.test.ts` + `livingWorldDirector.test.ts` (multi-sector harness `bootLivingWorldTestServer`), `tests/e2e/living-world.spec.ts`.

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
- **Temporal plausibility**: fire claims with `tick < serverTick - LAG_COMP_WINDOW` are **clamped** to `serverTick - LAG_COMP_WINDOW` (via `clampFireTick`) and lag-comp-resolved against the oldest ring pose — they are NOT rejected. Future claims (`tick >= serverTick - LAG_COMP_WINDOW`, incl. client running ahead) pass through unchanged (`getPoseAt(future)` → live-pose fallback). The old hard-reject silently dropped legitimate post-stall fires; the clamp keeps the rewind bounded identically so there is no abuse vector.
- **Weapon catalogue (data-driven)**: `handleFire()` resolves `weaponDef = getWeapon(weaponId)` from `src/core/combat/WeaponCatalogue.ts` and branches on `weaponDef.mode`. Hitscan reads `range`/`damage` from the def; projectile passes `damage`, `radius`, `maxTicks`, `weaponId` into `spawnServerProjectile`. Each `ProjectileRecord` carries its own `damage`/`radius`/`maxTicks` — `advanceProjectiles()` reads them off the record, never off a global constant. **Adding a new weapon never requires editing `SectorRoom.ts`** — only the catalogue.
- **Projectile vs swarm collision**: `advanceProjectiles()` runs two collision passes per projectile per tick — first against player ships (lag-comp via SnapshotRing — currently the spawn tick's SAB pose for projectiles), then against swarm entities via `swarmRegistry.all()` reading current SAB pose. The swarm pass is required: solo play has only drones/asteroids as targets, so a missing swarm loop = "lasers sail through everything." Hit position (`hitX`, `hitY`) is threaded into `applyDamage()` and broadcast in `DamageEvent` for the client damage-numbers/health-bars pipeline.
- **Multi-mount fire path (Phase 2a–4c)**: `handleFire` and `handleAiFire` iterate the firing ship's active-slot mounts via `resolveSlotMounts(kind, slotId?)`. Each mount produces an independent `laser_fired` broadcast with its own `mountId`, fire-from-position (`mountWorldOrigin(ship.pos, ship.angle, mount)` plus 20 u barrel offset along mount world direction), and lag-comp hit-test ray. The per-mount weapon resolves off `mount.weaponId` (data-driven; future loadout swap requires only catalogue edits). Aggregate `hit_ack` reports the closest mount-hit across the salvo.
- **Server-authoritative mount rotation**: `tickPlayerMounts()` and `tickDroneMounts()` run each `update()` and write to `playerMountAngles: Map<playerId, Float32Array>` + `droneMountAngles: Map<droneId, Float32Array>`. Cost: `playerMounts` ≈ 0.001–0.025 ms / tick at 1 player; `droneMounts` ≈ 0.016 ms avg / 0.033 ms max across 7 sectors (measured via `tick_budget`). `handleFire` reads `playerMountAngles[shooterId][mIdx]` for each mount's ray direction (no per-mount ring buffer yet — see `weapon-mounts.md` "Deferred work"). Cleanup paths (onLeave, transit, death, evictSwarmEntity) MUST clear both maps alongside `lastFireClientTick` or the maps leak across reconnects.
  - **Player aim is hostile-only + health-weighted (Part C, weapon-autofire-boost-mechanics).** `WeaponMountTicker.tickPlayer` filters candidates through the drone's `hostileTo` set (per-player, same source as `tickDrone`) and biases the pick toward low-HP drones via the SHARED `PLAYER_AIM_HEALTH_WEIGHT` / `PLAYER_AIM_SWITCH_MARGIN` constants — **identical options to the client's `tickLocalMountAim`** so the predicted beam and this authoritative mount angle agree (mount-angle lockstep, Invariant #12). Drone health comes from `swarmHealth` (passed LAZILY — `() => this.swarmHealth` — because the shield/hull router that owns the map is constructed AFTER the ticker in `SectorRoom`'s constructor; eager eval threw at boot). The same `swarmHealth` feeds the snapshot `drones[].hp` so client + server read the same health signal.
- **Per-recipient snapshot mountAngles**: `SnapshotMessage.states[id].mountAngles?` and `SnapshotMessage.drones[].mountAngles?` are emitted only when at least one mount has slewed past 0 — legacy single-mount kinds omit the field entirely, zero byte cost. Values quantised to 4 decimals (`Math.round(angle * 10_000) / 10_000`) so the JSON serialiser dedupes trailing-noise drift.
- **Drone `hp` percent (Part C)**: `SnapshotMessage.drones[].hp` (0-100 integer) is emitted by `SnapshotBroadcaster` ONLY for DAMAGED in-interest drones (full-HP omit it → the client treats absent as 100 %), so undamaged sectors pay zero extra bytes. Sourced from `swarmHealth` ÷ `getDroneMaxHealth(shipKind)`. It's a slim non-pose JSON field alongside `mountAngles`/`shieldDown` — **no `SWARM_WIRE_VERSION` bump** (pose still flows on the binary channel). The client decodes it to `SwarmRenderState.healthFrac` for health-weighted player turret aim. **Netcode-health gate (Invariant #8) applies** — the slice + the lockstep player-aim path are live-loop.
- **AI fire-gate widening**: `HostileDroneBehaviour.tickCombat` widens body-aim tolerance by the kind's `maxTurretHalfArc` (computed once at construction from the widest rotating mount's `(arcMax - arcMin) / 2`). Without this, drones with rotating turrets suppressed fires the turret AI would have resolved as hits. For legacy zero-arc kinds `maxTurretHalfArc = 0`, so the gate collapses to the pre-4c 14° / 26° tolerance.
- **`JoinOptions.droneKinds`**: deterministic ship-kind sequence for drone spawns (round-robin). When set, the spawner uses this instead of `pickRandomShipKind()`. Used by the `mount-test` engineering room. Absent ⇒ legacy random picker, no behavioural change.
- **Phase 6c — drones only see active hulls**: the AI view rebuild block in `SectorRoom.update()` filters `playerToSlot` entries on `ship.isActive === true`. Lingering hulls (Phase 6b — players who disconnected within the 15-min linger window OR whose ships were displaced by a fresh spawn) are skipped, so drones do not target them. The `hostileTo` set still remembers the playerId, so when the player rebinds (active again) the drone immediately resumes targeting — that's intentional. Lock test: [tests/integration/sectorRoom/droneTargetActiveOnly.test.ts](../../tests/integration/sectorRoom/droneTargetActiveOnly.test.ts). Client-side prediction is already correct via the snapshot translator in `ColyseusClient.handleSnapshot` (it skips `isActive=false` entries when building the playerId-keyed local mirror), so the Input Symmetry Rule is preserved without a separate client gate.

---

## SectorRoom subsystems (hazy-pillow Step 14 — 2026-05-25)

`src/server/rooms/SectorRoom.ts` (~4236 LOC) is decomposed into 10
state-owning subsystems. State lives on subsystems; method bodies
stay on SectorRoom for now (they span multiple subsystems each).
Full anatomy + deferred work in
[`docs/architecture/sector-room-anatomy.md`](../../docs/architecture/sector-room-anatomy.md).

| Field cluster | Subsystem | File |
|---|---|---|
| slot allocation (7 maps) | `this.slots` | [`PlayerSlotMap.ts`](rooms/PlayerSlotMap.ts) |
| swarm registry + interest grid | `this.swarm` | [`SwarmLifecycleManager.ts`](rooms/SwarmLifecycleManager.ts) |
| worker IPC | `this.physics` | [`PhysicsBridge.ts`](rooms/PhysicsBridge.ts) |
| fire / projectiles / drone HP-shield | `this.combat` | [`CombatSubsystem.ts`](rooms/CombatSubsystem.ts) |
| per-mount aiming | `this.mounts` | [`MountAimSubsystem.ts`](rooms/MountAimSubsystem.ts) |
| AI controller + view scratch | `this.ai` | [`AiSubsystem.ts`](rooms/AiSubsystem.ts) |
| snapshot cadence + TiDi clock + idle | `this.snapshot` | [`SnapshotBroadcaster.ts`](rooms/SnapshotBroadcaster.ts) |
| wreck conversion + ownerless evict | `this.wrecks` | [`WreckLifecycleCoordinator.ts`](rooms/WreckLifecycleCoordinator.ts) |
| session / identity / input counter | `this.players` | [`PlayerSessionManager.ts`](rooms/PlayerSessionManager.ts) |
| per-tick timing + hitch detection | `this.budget` | [`TickBudgetTelemetry.ts`](rooms/TickBudgetTelemetry.ts) |

`SectorRoom._internals` (Step 1) is the test-only piercing surface —
integration tests reach into private state through it rather than
declaring local cast interfaces. The 5 piercing integration tests
(`droneTargetActiveOnly`, `ramming`, `hitAckContract`, `lingering`,
`rosterFullWreck`) route through `_internals`; each subsystem
extraction updates the `_internals` getters without touching test
bodies.

---

## Threading

- Phase 2 evicts Rapier to a `worker_threads` worker; the main Colyseus thread reads SAB directly.
- Phase 7 (shipped) moves `node:sqlite` writes to a dedicated `worker_threads` worker via the same `bundleWorker` esbuild helper used by the physics worker. The main thread holds only a **read-only** `DatabaseSync` for auth `SELECT`s.
- If you are adding a new CPU-heavy subsystem, default to spawning a worker rather than running on the main thread.

---

## Testing patterns

- **Hand-rolled mocks for orchestrator-shaped logic**: `src/server/transit/TransitOrchestrator.test.ts` is the gold standard. `makeRoom()`, `makePlayerShipStore()`, `makeFakeClient()` factories let a test set up a Sector-room-shaped harness in ~50 lines of mock plumbing. Fast (~10 ms per case), no I/O, no IPC. Use this for any test that exercises decision logic over state — the messages-to-state-to-broadcasts pipeline doesn't need a real server.
- **Integration tests for end-to-end snapshot routing** (Phase A1, 2026-05-13): `tests/integration/sectorRoom/harness.ts` boots a real `Server` + `SectorRoom` + `WebSocketTransport` + `colyseus.js` client in the same node process. Run via `pnpm test:integration` (separate vitest config — `vitest.integration.config.ts`). Use this whenever a behaviour spans the snapshot wire format, the broadcast gates (idle suppression, backpressure), or the schema-diff serialisation. The Phase 6b "lingering hull invisible" bug class is the canonical reason: the bug was in the broadcast loop's iteration, not in the room's state-mutation code. A hand-rolled mock couldn't catch it. The integration test would have.
- **When introducing a new visible entity type** (wreck, lingering hull, future X), add an integration test in `tests/integration/sectorRoom/` that drives the full snapshot path. Don't rely on smoke tests — they are not repeatable and don't protect future PRs.
- **Integration clients MUST send `client_ready` or ships never activate (2026-06-03).** The bare `colyseus.js` client in `harness.ts` does NOT run the browser's bootstrap, so without an explicit `client_ready` the join handshake never completes — `ship.isActive` stays `false` until the 30-s `CLIENT_READY_TIMEOUT_TICKS` watchdog. Tests that assert on active hulls (`abandonToWreck`, `lingering`) were silently RED for this reason. Use `harness.connectActive(playerId, opts)` (sends `client_ready`, polls until `isActive`) for any test that needs a live hull; plain `connectAs` only gives a pending/lingering-able hull. The `SectorRoom._internals` piercing getter (dropped by the v3 subsystem extraction, which had left `hitAckContract`/`droneTargetActiveOnly`/`ramming`/`lingering` erroring with `_internals` undefined) was **restored 2026-06-03** (exposes `serverTick`, `ownerlessShips`, `aiPlayerScratch`, `postToWorker`, `applyDamage`). The lingering/wreck/pool suite is now green. The combat/AI files (`hitAckContract`, `droneTargetActiveOnly`, `ramming`) still need `connectActive` for their active-ship spawns (the same `client_ready` gap) — a mechanical follow-up outside the lingering/wreck scope.

## Generic Entity Pipeline — OOP damage dispatch + a new pose-core kind (2026-06-04)

> Updated 2026-06-04 (GEP B2): the data-driven `strategies[kind]` table is now
> the **OOP entity pipeline**. The damage SHAPE is real leaf objects, not a
> side table.

`DamageRouter.apply` routes through real Entity LEAVES: `EntityResolver.resolve(targetId)`
returns the live leaf it names (`ShipEntity` / `WreckEntity` / `DroneEntity` /
`StructureEntity` in [src/server/entity/leaves/](entity/leaves/)), then ONE
monomorphic `DamageRouter.applyInteraction(leaf, …)` reads the leaf's COMPOSED
`{ health, perHit, death }` data (`applyLayered → broadcast → perHit → death`).
Each leaf owns its identity + pose and composes its damage strategy + sync/render
descriptors — a new damageable type is **a leaf + a registry row**, ZERO new
dispatch branch here. Byte-identical to the former if-tree / strategy-table
(locked by `DamageRouter.dispatch.test.ts`, the golden-master — HC#1: branch
order + per-branch side-effects are load-bearing). The ordered shape-based
selection (wreck→lingering→active→swarm; an asteroid, kind 0, is **non-damageable**
→ the resolver returns `null` = immune) lives in
[EntityResolver.ts](entity/EntityResolver.ts).

**HC#5 (monomorphism guard).** `applyInteraction` is ONE concrete function
reading the leaf's composed DATA — it must NEVER become a per-class virtual
`leaf.receiveInteraction()` across the N leaf classes (that megamorphic-deopts in
V8 under ramming/projectile load). The leaves are objects for identity/sync/render
(where polymorphism is cheap + clarifying); the per-hit hot work stays one
monomorphic call site. Lock: the `DO NOT replace this with receiveInteraction`
guard comment + `benchmarks/damageDispatch.bench.ts` (mixed-kind ≈ single-kind
per `apply` — no cliff). Adding a damageable type does **not** add a branch here.

A new **pose-core** entity type (e.g. `SWARM_KIND_STRUCTURE = 2`) is a
swarm-registry record — it rides `BinarySwarmBroadcast` (writes `rec.kind`
as-is, no encoder change), the interest grid (reuses the single per-(client,tick)
`interestScratch`, no new `query9`), and the `DamageRouter` 'swarm' strategy for
free. The only damage-specific line is seeding `swarmHealth` on spawn (absence =
immune, like asteroids). `SwarmSpawner.spawnStructure` mirrors `spawnAsteroid`
(`spawnOne` is already kind-generic). Test trigger: the testMode `structurePoses`
room option (mirrors `dronePoses`) → `structure-test` E2E room. New visible type
⇒ the integration-test mandate above applies (`structureEntity.test.ts`). Full
story: [docs/architecture/generic-entity-pipeline.md](../../docs/architecture/generic-entity-pipeline.md).

**Player-driven structure placement (structures plan, Phase 2).** Beyond the
testMode `structurePoses` seed, players place structures over the wire:
`place_structure` / `remove_structure` (zod `.strict()`,
`src/shared-types/messages/clientMessages.ts`) → `SectorRoom` handlers (resolve
owner via `sessionToPlayer`) → [StructurePlacementSubsystem](structures/StructurePlacementSubsystem.ts)
(decision logic over injected hooks — spawn / health-seed / despawn / clamp / id —
unit-tested like `TransitOrchestrator`) + [StructureRegistry](structures/StructureRegistry.ts)
(ownership + construction state). Placement model: every structure lands a
**blueprint** at `SCAFFOLDING_HP_FRACTION` (10 %) HP, `isConstructed:false`,
non-operational; the **Capital** is the exception (`constructionCost===0` ⇒
pre-built, full HP, the mineral bank). Placement does NOT pre-charge minerals —
the cost is drained DURING construction by the Phase-3 grid pulse, so a blueprint
can be placed with an empty bank and waits. The structure subtype rides the
**shared `shipKind` byte** (kind=2 path; `SwarmSpawner.spawnStructure` sets
`rec.shipKind`) — no stride/`SWARM_WIRE_VERSION` bump. `remove` is owner-gated.
`SectorRoom._internals` exposes `structureRegistry` + the swarm record `shipKind`
for the integration test.

**Power grid (structures plan, Phase 3).** `StructureRegistry` carries the
connection adjacency (+ `topologyDirty` + per-structure `minerals`; `remove()`
severs). `structureGridView.autoConnectStructure` runs on every place (nearest
in-range hub, per-owner). `StructureGridSubsystem.pulse()` is the **1 Hz
heartbeat** — directly callable so integration tests drive it deterministically
(no wall-clock wait), `unref`'d + OFF the 60 Hz tick: rebuild-if-dirty →
construction flow (drain a routable Capital; complete ⇒ build + reset HP + dirty;
dry ⇒ pause) → repair → deconstruction → flashes. `SectorRoom` owns the timer,
rebuilds the `structures[]` slice (entityId-keyed; same array ref per recipient,
absent when none), broadcasts `grid_pulse`, severs on structure death via
`evictSwarmEntity`. `_internals.pulseStructureGrid` + `getStructuresSlice` are
the test seams. **Netgate (invariant #8): the `structures[]` slice + `grid_pulse`
touch the snapshot/broadcast path, so `pnpm e2e:netgate` is required for grid
changes.** Phase 4 adds the mining + transfer pulse steps (`findNearestAsteroid`
hook; power-gated extraction → local buffer → haul to Capital). Phase 5 adds
`tickTurrets` on a faster `TURRET_TICK_MS` timer — built+powered turrets target
the nearest drone (`findNearestDrone`) and fire (`applyDamage` + `laser_fired`);
a **bespoke fire path**, NOT `AiFireResolver` (which targets players). The
testMode **scenario trigger** (`prebuiltStructures`/`scenarioDrones`/
`scenarioAsteroids` → `seedStructureScenario`, the `structure-scenario-test`
room) seeds a pre-built powered grid for E2E (the place-ahead UI overlaps stacked
placements; this seeds the end state). See [docs/architecture/structures-and-power-grid.md](../../docs/architecture/structures-and-power-grid.md).

**EntitySyncRouter (GEP B4) — the per-tick send orchestration seam.** Both
entity-sync sends in `SectorRoom.update()` now route through ONE
[EntitySyncRouter](rooms/EntitySyncRouter.ts) `route(phaseTime)` call instead of
calling the two broadcasters directly. The router owns the **ordering decision**
— pose-core binary FIRST (`SwarmBroadcaster.broadcast()` builds the
per-(client,tick) `interestScratch`), then json-slice
(`SnapshotBroadcaster.broadcast(sectorIdle)` reuses it, no second `query9` —
**HC#4, now enforced by the router, not the caller**) — and evaluates sector-idle
**between** the two sends (verbatim: `swarm.broadcast` may apply backpressure
before idle reads `clients.length`, so the order is preserved, not reordered).
The proven broadcasters keep their **byte-level encoding UNCHANGED** (the safe
shape — making the router own per-entity iteration would move wire bytes for zero
gain; STOP+flag + netgate if ever attempted). Its constructor runs a **boot-time
`SyncProfile.transport` governance check** (`assertTransportGovernance`) that
validates every `EntityKindRegistry` kind's transport is well-formed and that the
pose-core bytes match the wire constants — this is what finally makes
`SyncProfile.transport` load-bearing (boot-time only, never in the `route()` hot
path). Hot path is allocation-free (#14): the idle closure is built once at
construction, `phaseTime` is passed by reference. Lock: `EntitySyncRouter.test.ts`
(ordering + idle-threading + governance); the full-snapshot-path byte-identity is
the netgate + the existing integration suite.

## Lingering-hull → wreck symmetry (2026-06-03)

"An abandoned ship becomes a wreck if it's still in the game world, otherwise it vanishes." A **lingering** hull (disconnected / fresh-spawn-displaced, `isActive=false`) is still in the world (a remote observer renders it from `mirror.lingeringShips`), so abandoning it must leave a wreck — symmetric with abandoning an active hull. `findAbandonedShips` ([rooms/sectorIdleEvaluator.ts](rooms/sectorIdleEvaluator.ts)) returns BOTH active and lingering abandoned ships (no `!isActive` skip) with a `lingering` flag; the `update()` poll routes active → `convertShipToWreck(playerId)` and lingering → `WreckLifecycleCoordinator.convertLingeringHullToWreck(shipInstanceId)`. The lingering path is **shipInstanceId-keyed** because the owning player may be piloting a DIFFERENT active hull — it reads `lingeringSlots`/`lingeringPoseCache`, rekeys the worker body `linger-${id}` → `wreck-${id}`, cancels the ownerless-evict timer, and **never touches any playerId-keyed map**. Locks: [abandonLingeringToWreck.test.ts](../../tests/integration/sectorRoom/abandonLingeringToWreck.test.ts) + the browser-level `tests/e2e/linger/abandon-lingering-wreck.spec.ts`. The galaxy-only linger/wreck/pool flows are E2E-driven through the isolated `galaxy-test` room + the `lingerMs` trigger (see the root CLAUDE.md bespoke-triggers table).

## Shield/Hull + ramming (2026-05-16)

- Two-layer survivability for all ships. `applyDamage` routes
  active/lingering/drone through `ShieldHull.applyLayeredDamage`
  (no-spillover: the final pre-drop hit is fully absorbed). Per-update
  `tickShieldRegen` (cheap full-shield skip, no per-tick alloc). On the
  shield 0-cross/restore: `SET_HULL_EXPOSED` worker post + bus
  `SHIELD_BROKEN`/`SHIELD_RESTORED` + `shield_broken`/`shield_restored`
  serverLogEvent diagnostics.
- Shield value reaches clients on DISCRETE events only: `DamageEvent`
  (`newShield/shieldMax/hullMax/hitLayer`) per hit + `ShieldEventMessage`
  (`restored`/`regen_complete`). The regen ramp is NEVER streamed (no
  Colyseus schema field; `ShipState.shield` is a plain non-@type field).
- Drones: `SWARM_RECORD_FLAG_SHIELD_DOWN = 1<<1` (spare recordFlags bit
  — NO stride change, NO `SWARM_WIRE_VERSION` bump) + `drones[].shieldDown`
  on the snapshot. `SwarmEntityRecord.shieldDown` maintained event-driven.
- Ramming (`src/core/combat/Ramming.ts`): CONTACT_BATCH aggregated per
  unordered {aId,bId} per tick BEFORE floor/damage/broadcast (a
  shield-down hull is N triangle colliders → N sub-events). Symmetric;
  asteroids deal but don't take.
- `feel-test-lockstep.spec.ts` is host-load sensitive — confirm on a
  quiet host/CI (it fails on pre-shield HEAD too in a loaded session;
  see docs/LESSONS.md 2026-05-16). Catalogue version bumped 1→2.
