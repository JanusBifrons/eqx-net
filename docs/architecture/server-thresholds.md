# Server thresholds

The current numeric limits and budgets of the server zone. The rules that use them are in
[`src/server/CLAUDE.md`](../../src/server/CLAUDE.md) ("Thresholds and subsystem rules"); how each
subsystem works is in its own guide (linked per row).

**A new or changed threshold goes in this table, not in `CLAUDE.md`.** A value is current while the
constant it names exists in `src/` (`git grep -n <CONST> -- src`). When a constant is removed or a
value is superseded, move its row to [History](#history). Values were checked against the code on
2026-11-14; the code is the source of truth if they ever disagree.

## Current values

### Security and inbound messages ([security](security.md))

| Name | Value | Constant + file | What it bounds | Lock |
|---|---|---|---|---|
| CORS allowlist | `ALLOWED_ORIGINS` (comma-separated); unset ⇒ non-prod reflects ANY origin (dev/LAN/netgate), prod is closed | `resolveCorsPolicy`, `src/server/net/httpCors.ts` | Which origins may call the HTTP API | `httpCors.test.ts` |
| Auth write rate limit | 10 / min / IP (login + register combined); 429 + `Retry-After` | `AUTH_WRITE_MAX`, `AUTH_WRITE_WINDOW_MS`, `src/server/routes/authRouter.ts` (limiter in `src/server/net/HttpRateLimit.ts`) | Password guessing / account spam. `/healthz` and `/diag` are not limited | `HttpRateLimit.test.ts` |
| OAuth rate limit | 30 / min / IP (`/auth/google*` + `/auth/exchange`) | `OAUTH_MAX`, `OAUTH_WINDOW_MS`, `src/server/routes/authRouter.ts` | OAuth endpoint abuse | `HttpRateLimit.test.ts` |
| Inbound string id length | `.min(1).max(64)` on every inbound wire id | zod schemas in `src/shared-types/messages*` | Oversized ids from a client | `messages.test.ts` |
| testMode seed array size | ≤ 64 entries, checked at `onCreate` | `MAX_SEED_ENTRIES`, `src/server/rooms/roomSeedBounds.ts` | Room seed arrays from a client | `roomSeedBounds.test.ts` |
| Test-room gating | non-galaxy rooms register only when `NODE_ENV !== 'production'` OR `EQX_ENABLE_TEST_ROOMS=1`; `EQX_ALLOW_DEV_OVERRIDES=1` in production logs a boot warning | `src/server/rooms/testRoomGating.ts` | Test rooms reachable in production | `testRoomGating.test.ts` |
| JWT secret | production throws at boot on a missing / placeholder `JWT_SECRET` | auth boot | Fail-closed auth | — |
| Input rate limit | max 3 inputs per entity per tick in `onMessage`; excess silently dropped | `MAX_INPUTS_PER_TICK`, `src/server/rooms/SectorRoom.ts` (applied in `InputHandler.ts`) | Input flooding | — |
| Lock message cap | max 3 per session per tick for `lock_request` / `lock_track` / `lock_cancel` / `set_group_mode` together (`lockMsgAllowed`, cleared at the top of `update()`); excess silently dropped | `MAX_LOCK_MSGS_PER_TICK`, `src/server/rooms/SectorRoom.ts` | Fire-control message flooding | `LockSubsystem.test.ts` |
| RTS fleet command cap | max 4 per session per tick for `fleet_order` / `set_mode` / `set_stance` / `form_squad` / `disband_squad` together (`fleetMsgAllowed`, cleared at the top of `update()`); excess silently dropped | `MAX_FLEET_MSGS_PER_TICK`, `src/server/rooms/SectorRoom.ts` | Fleet command flooding ([fleet-command](fleet-command.md)) | — |

### Snapshot, interest and network ([snapshot-cadence](snapshot-cadence.md))

| Name | Value | Constant + file | What it bounds | Lock |
|---|---|---|---|---|
| Snapshot rate | single 20 Hz cadence with a per-client phase offset hashed from playerId; scheduling tick is `broadcastCounter`, not `serverTick` | `shouldBroadcastFar`, `src/server/net/snapshotScheduler.ts` | Snapshot bandwidth and per-tick CPU peaks | `snapshotScheduler.test.ts` |
| Idle-sector suppression | no motion above epsilon AND no projectiles in flight for 60 consecutive ticks ⇒ no broadcasts | `IDLE_THRESHOLD_TICKS`, `src/server/rooms/SectorRoom.ts` | Bandwidth in quiet sectors | — |
| Join broadcast grace | 300 ticks (5 s at 60 Hz) of forced broadcasts after every join / spawn / reconnect | `JOIN_BROADCAST_GRACE_TICKS`, `src/server/rooms/SectorRoom.ts` | A just-joined still ship starved of snapshots ([warp-visual](warp-visual.md)) | `tests/integration/sectorRoom/joinBroadcastGrace.test.ts` |
| Backpressure | `ws.bufferedAmount` > 50 KB drops the oldest queued snapshot; > 250 KB force-closes the socket | `DROP_THRESHOLD`, `CLOSE_THRESHOLD`, `src/server/net/Backpressure.ts` | A slow client's send queue | — |
| Interest grid cell | 2048 u cells; a client gets entities in its 3×3 cell window at full fidelity | `CELL_SIZE`, `src/server/interest/SpatialGrid.ts` | Per-client snapshot size | `SpatialGrid.test.ts` |
| Out-of-interest decimation | out-of-interest swarm entities still ship every 6 ticks | `DECIMATION_TICKS`, `src/server/net/BinarySwarmBroadcast.ts` | Far-entity bandwidth | `BinarySwarmBroadcast.test.ts` |
| Swarm wire version | 7 (stride 36; decoder hard-fails older versions) | `SWARM_WIRE_VERSION`, `src/shared-types/swarmWireFormat.ts` | Binary swarm record layout (root invariants #11, #12) | `tests/unit/swarmWireRoundTrip.test.ts` |
| Spin delta trigger | `|Δω| > 0.05 rad/s` ships a fresh pose | `QUANT_ANGVEL`, `src/server/net/SwarmEntityRegistry.ts` | Spinning-but-still drones going stale | `BinarySwarmBroadcast.test.ts` |
| Far drones' slim slice | out-of-interest drones' `hostile` / `hp` on one snapshot in 10 per recipient (2 Hz) | `FAR_DRONE_SLICE_EVERY`, `src/server/rooms/SnapshotBroadcaster.ts` | Far-tier hostility / hp bandwidth | `SnapshotBroadcaster.farDrones.test.ts`, `hostilityOnSnapshot.test.ts` |

### Combat and lag compensation ([fire-control](fire-control.md), [capital-ships](../features/capital-ships.md))

| Name | Value | Constant + file | What it bounds | Lock |
|---|---|---|---|---|
| Lag-comp window | 12 ticks (~200 ms); older fire claims are clamped to the window floor, not rejected | `LAG_COMP_WINDOW`, `src/server/rooms/PlayerFireResolver.ts`; helper `clampFireTick`, `src/core/combat/fireTemporal.ts` | Rewind depth (no abuse advantage) | `fireTemporal.test.ts` |
| Lag-comp ring | 2048 entities × 12 ticks × 6 floats (x, y, vx, vy, angle, angvel) = 576 KB per sector, pre-allocated | `RING_CAPACITY`, `RING_DEPTH`, `FLOATS_PER_ENTRY`, `src/server/lagcomp/SnapshotRing.ts` | Per-tick allocation (none) | `SnapshotRing.test.ts` |
| NPC lock step | budget 0.1 ms per step (every 6 ticks, O(pilots × hostile NPCs)); measured ~0.015 ms at 56 drones × 4 pilots, ~0.037 ms at 56 × 10 (laptop 2026-11-09); after lock-at-any-distance, warm steady state ~0.02 ms at 56 × 4, ~0.06 ms at 56 × 10 (near or 20 km out), ~0.015 ms at 8 battleships × 10 (laptop 2026-11-15; profile: per-pair visitor ~22 %, `lockSeconds` ~12 %, fire-range refresh ~8 %). The vitest-bench p75 on a busy machine reads 0.10–0.14 ms at 56 × 10 (JIT warm-up and load noise): compare it only A/B in one session | `benchmarks/npc-locks.bench.ts` | NPC lock cost as pilots grow | `npc-locks.bench.ts` |
| Capital turret tick | budget 10 µs per capital; measured ≈ 2.4 µs per battleship per tick (8 battleships × 4 pilots = 0.02 ms) | `benchmarks/capital-mounts.bench.ts` | Capital mount cost | `capital-mounts.bench.ts` |
| Capital broadside stand-off | 0.75 of main reach | `BROADSIDE_STANDOFF`, `src/core/ai/HostileDroneBehaviour.ts` | Unposted capital range keeping | `capitalClosesRange.test.ts` |
| Mining-tool reach by mount size | catalogue range × size reach / XL reach (AA 0.8, S 1, M 1.25, L 1.6 over XL 2.2; unsized = S): mining laser XL 12,000, L ≈ 8,727, M ≈ 6,818, S ≈ 5,455, AA ≈ 4,364 u; tractor XL 3,000 … AA ≈ 1,091 u; guns unscaled | `miningReachFactor` / `mountWeaponReach`, `src/core/combat/mountReach.ts` (`MOUNT_SIZE_TUNING`, `src/shared-types/shipScale/tuning.ts`) | Where a mining laser or tractor may fire (both sides' fire gate) | `mountReach.miningGradient.test.ts`, `miningReachParity.test.ts`, `miningReach.test.ts` |
| Capital turret fire tolerance | barrel within 0.05 rad of the lead bearing (AI drone mount path) | `TURRET_FIRE_TOLERANCE`, `src/core/combat/mountFireControl.ts` | When a capital mount may fire | `tests/unit/capitalCombat.test.ts` |
| Turret fire miss distance | a barrel bears within 60 u of the aim point (player mounts; a turret only for a target with no hit shape: NPC capital and structure turrets otherwise fire the moment the barrel ray hits, `barrelRayHits`) | `TURRET_FIRE_MISS`, `src/core/combat/mountFireControl.ts` | Naval turret fire and player naval guns (#19) | `tests/unit/capitalCombat.test.ts` |
| Capital turret retarget | search every 30 ticks (staggered); hold a lost target 60 ticks | `RETARGET_TICKS`, `TARGET_HOLD_TICKS`, `src/server/rooms/WeaponMountTicker.ts` | Per-turret target churn | `capitalEngagement.test.ts` |
| Capital turret tracking | `canTrack`: bearing rate ≤ 0.8 × traverse | `src/core/combat/mountTargeting.ts` | Slow guns chasing fast craft | `tests/unit/capitalCombat.test.ts` |
| Naval barrel span | 0.62 (shared with the bake) | `NAVAL_BARREL_SPAN`, `src/core/combat/muzzle.ts` | Per-barrel shell origin (#15) | — |
| Shell view (real ranges) | reach × 1.05, aspect 2.4 | `GUN_VIEW_MARGIN`, `MAX_VIEW_ASPECT`, `src/shared-types/shipScale/tuning.ts` | Who receives `shell_salvo` events ([shell-events](shell-events.md)) | `ShellEventHub.test.ts` |
| Line-of-fire gate | 2022 candidates, 296 narrow tests per tick | `LINE_OF_FIRE_BUDGET`, `src/shared-types/perf/perfBudgets.ts` | NPC friendly-fire hold checks ([allegiances](allegiances.md)) | `LineOfFireGate.test.ts`, `perfSceneCounts.test.ts` |
| Blocked-shot memory | recent-block count halves every 30 ticks | `BLOCK_HALF_LIFE_TICKS`, `src/core/ai/HostileDroneBehaviour.ts` | NPC reaction to a blocked line of fire | `npcLineOfFire.test.ts` |
| Hostility decay | 1800 ticks (30 s) | `FORGET_TICKS`, `src/core/ai/HostileDroneBehaviour.ts` | How long a drone stays hostile | `HostileDroneBehaviour.test.ts` |
| AI neighbour grid cell | 4 × the default fighter `flockSeparation` (#18); "rebuild + 200 K=8 queries" ≈ 0.02 ms | `NEIGHBOUR_CELL_SEPARATIONS`, `src/server/rooms/AiNeighbourGrid.ts`; `benchmarks/ai-allegiance.bench.ts` | Drone-brain proximity queries | `AiNeighbourGrid.test.ts` |

### Load and time ([game-time-scale](game-time-scale.md))

| Name | Value | Constant + file | What it bounds | Lock |
|---|---|---|---|---|
| Over-budget tick | 14 ms | `OVER_BUDGET_MS`, `src/core/clock/SimulationClock.ts` | When a sector counts as overloaded (feeds `LoadSpeedController`) | `SimulationClock.test.ts` |
| Load slowdown floor | 0.7× (ramp 0.005 per tick) | `TIDI_FLOOR`, `RAMP_PER_TICK`, `src/core/clock/SimulationClock.ts` | Lowest automatic sector speed | `SimulationClock.test.ts` |
| Load shedding | fires when rate ≤ `TIDI_FLOOR + 0.01` (0.71) AND `max(serverTotalMs, workerTickMs) > 14`; batch `min(8, ceil(drones × 0.10))` per tick; summary log at most once per 10 s per room | `FLOOR_GATE`, `SHED_LOG_INTERVAL_MS`, `src/server/orchestration/LoadShedder.ts` | Drone count under sustained overload | `LoadShedder.test.ts`, `tests/integration/sectorRoom/loadShedOutOfView.test.ts` |

### Persistence ([persistence-and-migrations](persistence-and-migrations.md))

| Name | Value | Constant + file | What it bounds | Lock |
|---|---|---|---|---|
| CRITICAL write-ahead buffer | 50 ms window, one `BATCH` per window; cap 10 000 ops (force-flush) | `WAB_FLUSH_MS`, `CRITICAL_CAP`, `src/server/db/WorkerBackedSink.ts` | Write coalescing | `WorkerBackedSink.test.ts` |
| VOLATILE buffer | up to 5 000 ops, oldest dropped, while the worker is unavailable | `VOLATILE_CAP`, `src/server/db/WorkerBackedSink.ts` | Telemetry memory while the DB worker is down | `WorkerBackedSink.test.ts` |
| Awaitable write timeout | 2 s (`enqueueCriticalAwaitable`, auth `register` only) | `AWAITABLE_TIMEOUT_MS`, `src/server/db/WorkerBackedSink.ts` | Register round-trip | `WorkerBackedSink.test.ts` |
| Shutdown drain | 8 s (`persistence.shutdown({ timeoutMs: 8000 })`) | `src/server/index.ts` | Graceful shutdown | — |
| Sector snapshot save | every 3600 ticks (60 s) and on `onDispose` | `SectorRoom.ts` (`ticksSinceSnapshot`) | Sector state lost on a crash | `SectorPersistence.structures.test.ts` |
| Sector snapshot staleness | rows older than 24 h are discarded | `SNAPSHOT_STALENESS_MS`, `src/server/rooms/SectorSnapshot.ts` | Restoring a very old world | `SectorSnapshot.test.ts` |
| Sector snapshot schema | 7 (a bump tears down all sectors and reseeds) | `CURRENT_SCHEMA_VERSION`, `src/server/rooms/SectorSnapshot.ts` | Snapshot shape | `SectorSnapshot.test.ts` |
| Structure persist coalesce | 2 s | `STRUCTURE_PERSIST_COALESCE_MS`, `src/server/rooms/SectorPersistence.ts` | Structure write rate | `SectorPersistence.structures.test.ts` |
| Ship roster soft guard | 200 ships per player (anti-abuse only; no gameplay cap since RTS, rosters are unlimited) | `ROSTER_SOFT_GUARD`, `src/server/playerShips/PlayerShipStore.ts` | Persistent ships per player | `PlayerShipStore.test.ts` |
| Ship-kind catalogue version | 25 | `SHIP_KIND_CATALOGUE_VERSION`, `src/shared-types/shipKinds.ts` | Hydrate-time drift clamp of stored ships | `tests/unit/shipKinds.test.ts` |
| Structure-kind catalogue version | 10 | `STRUCTURE_KIND_CATALOGUE_VERSION`, `src/shared-types/structureKinds.ts` | Saved structures (a bump discards them) | — |
| Director state | version 1; 24 h staleness; persisted every 60 s from the control loop and at shutdown | `DIRECTOR_STATE_VERSION`, `DIRECTOR_STATE_STALENESS_MS`, `src/server/livingworld/DirectorPersistence.ts`; `DIRECTOR_PERSIST_INTERVAL_MS`, `LivingWorldDirector.ts` | Director restart continuity | `DirectorPersistence.test.ts` |

### Transit and sectors ([travel-state](travel-state.md), [galaxy-graph](galaxy-graph.md))

| Name | Value | Constant + file | What it bounds | Lock |
|---|---|---|---|---|
| Player warp spool | 30 s, ship stays in the source room and is damageable | `SPOOL_DURATION_MS`, `src/core/transit/TransitStateMachine.ts` | Escape-by-warp | `TransitOrchestrator.test.ts` |
| Seat reservation | 15 s (`setSeatReservationTime(15)` in `onCreate`) | `src/server/rooms/SectorRoom.ts` | Transit seat hand-off | — |
| Arrival clamp | `SECTOR_PLAYABLE_HALF_EXTENT` (solar sectors on: 200 000 u; else the home pocket) | `src/shared-types/sectorBounds.ts` | Requested arrival point ([configurable-arrival](../features/configurable-arrival.md)) | `TransitOrchestrator.test.ts` |

### Leveling ([leveling-and-upgrades](leveling-and-upgrades.md))

| Name | Value | Constant + file | What it bounds | Lock |
|---|---|---|---|---|
| Ship level cap | 10 | `LEVEL_CAP`, `src/core/leveling/shipXp.ts` | Ship progression | `shipXp.test.ts` |
| XP per kill | `round(victimMaxHealth / 40)`, at least 1 | `XP_PER_KILL_DIVISOR`, `src/core/leveling/shipXp.ts` | XP award | `shipXp.test.ts` |
| XP curve | `round(100 · level^1.5)` to next level | `XP_CURVE_BASE`, `src/core/leveling/shipXp.ts` | Level pacing | `shipXp.test.ts` |
| Structure level cap | 5 | `STRUCTURE_LEVEL_CAP`, `src/core/leveling/structureLevel.ts` | Structure upgrades | `structureLevel.test.ts` |
| Structure level gain | +0.25 per level on key stats | `STRUCTURE_LEVEL_FRAC`, `src/core/leveling/structureLevel.ts` | Levelled max hull, turret damage, power output | `structureLevel.test.ts` |
| Structure upgrade cost | `base · (1 + level · 1.0)` | `STRUCTURE_UPGRADE_COST_FRAC`, `src/core/leveling/structureLevel.ts` | Upgrade price | `structureLevel.test.ts` |

### Living world ([living-world](living-world.md), [wave-attacks](../features/wave-attacks.md))

| Name | Value | Constant + file | What it bounds | Lock |
|---|---|---|---|---|
| Drone squads | 7 squads × 8 = 56 bots | `LIVING_WORLD_SQUAD_COUNT`, `SQUAD_SIZE`, `src/server/livingworld/director/SquadPool.ts`; `LIVING_WORLD_BOT_COUNT`, `LivingWorldDirector.ts` | Drone population | `livingWorldDirector.test.ts` |
| Robot squads | 4 squads × 6 = 24 bots | `ROBOT_SQUAD_COUNT`, `ROBOT_SQUAD_SIZE`, `src/server/livingworld/robotDirector.ts` | Robot population; all 80 bots in one sector ≈ 0.35 ms/tick (`ai-allegiance.bench.ts`) | `robotDirector.test.ts` |
| Ambient patrol floor | 0 per galaxy sector (roaming squads provide presence) | `AMBIENT_DRONE_FLOOR`, `src/core/galaxy/galaxy.ts` | Boot-seeded drones | `livingWorldDirector.test.ts` |
| Director control loop | 1.5 s; respawn delay 12 s; arrival cooldown 5 s; player-sticky 30 s; max 4 migrations per tick; shed recovery 10 s; initial stagger 200 ms | `DEFAULT_LIVING_WORLD_OPTIONS`, `src/server/livingworld/LivingWorldDirector.ts` | Director cadence and anti-flap | `livingWorldDirector.test.ts` |
| Drone hop spool | 2.5 s per hop (env `EQX_BOT_SPOOL_MS`) | `DRONE_HOP_SPOOL_MS`, `LivingWorldDirector.ts` | Wave traversal speed | `LivingWorldDirector.hopSpool.test.ts` |
| Wave final-approach spool | 30 s | `waveApproachSpoolMs`, `DEFAULT_LIVING_WORLD_OPTIONS` | Warning time before a wave arrives | `LivingWorldDirector.hopSpool.test.ts` |
| Hop travel | 0 (atomic hop; env `EQX_BOT_HOP_MS`) | `hopTravelMs`, `DEFAULT_LIVING_WORLD_OPTIONS` | Invisible in-flight window (none) | `HunterBotWarpController.test.ts` |
| Roam dwell | 6 min between roam hops | `roamIntervalMs`, `DEFAULT_LIVING_WORLD_OPTIONS` | Roamer visibility (feel knob) | `livingWorldFormation.test.ts` |
| Wave dispatch | ≤ 1 squad per ready faction per 5 min | `DEFAULT_DISPATCH_INTERVAL_MS`, `src/server/livingworld/director/WaveDirector.ts` | Wave frequency | `WaveDirector.test.ts` |
| Wave attack time-box | 3 min | `waveMaxAttackMs`, `DEFAULT_LIVING_WORLD_OPTIONS` | One wave phase | `WaveDirector.test.ts` |
| Rally hold | 90 s | `rallyMaxMs`, `DEFAULT_LIVING_WORLD_OPTIONS` | Rally-before-breach wait | `LivingWorldDirector.rallyBreach.test.ts` |
| Faction peaceful timeout | 3600 ticks | `FACTION_PEACEFUL_TIMEOUT_TICKS`, `src/core/faction/Faction.ts` | De-escalation | `WaveDirector.test.ts` |
| Flock course and gather | course ring 2000 (× sector space), leg spread π/2, gather radius 500, leader cruise throttle 0.55, follow distance 220 | `FORMATION_DEST_RANGE`, `FORMATION_LEG_SPREAD`, `FLOCK_GATHER_RADIUS` (`LivingWorldDirector.ts`); `LEADER_CRUISE_THROTTLE` (`HostileDroneBehaviour.ts`); `FLOCK_FOLLOW_DISTANCE` (`src/core/ai/flocking.ts`) | Squad herding (feel knobs) | `flocking.test.ts`, `HostileDroneBehaviour.flock.test.ts` |
| Recent-combat window | 5 min sliding | `RECENT_COMBAT_WINDOW_MS`, `src/server/rooms/RecentCombatLog.ts` | Galaxy-map combat icon, roam avoidance | `RecentCombatLog.test.ts` |
| Named elites | 2 alive; respawn 8 min | `MAX_ELITES`, `ELITE_RESPAWN_MS`, `src/server/livingworld/EliteDirector.ts` | Elite population ([bounties-and-events](../features/bounties-and-events.md)) | `tests/integration/sectorRoom/eliteDirector.test.ts` |
| Robot sector control | pressure −100..100; claim at 60, release at 20; 1.5 per s | `CONTROL_MAX`, `CLAIM_AT`, `RELEASE_AT`, `PRESSURE_RATE_PER_S`, `src/core/territory/sectorControl.ts` | Robot territory ([robot-territory](../features/robot-territory.md)) | `sectorControl.test.ts` |

### Cargo and economy ([loot-and-cargo](../features/loot-and-cargo.md), [economy-and-trade](economy-and-trade.md))

| Name | Value | Constant + file | What it bounds | Lock |
|---|---|---|---|---|
| Loot pods per sector | 64 (merge, never evict value; merge radius 60) | `MAX_LIVE_LOOT_PER_SECTOR`, `LOOT_MERGE_RADIUS`, `src/server/cargo/LootSubsystem.ts` | Live pods | `LootSubsystem.test.ts` |
| Loot pod TTL | 15 min | `LOOT_POD_TTL_MS`, `src/server/cargo/LootSubsystem.ts` | Pod lifetime | `LootSubsystem.test.ts` |
| Loot pickup radius | 80 u at 1× (scales with ship size, #18) | `LOOT_PICKUP_RADIUS` (`shipTuning.lootPickup`), `src/server/cargo/LootSubsystem.ts` | Pickup reach; collect every 6 ticks, sweep ~1 Hz | `LootSubsystem.test.ts` |
| Salvage sizes (tractor haul mass) | AA 60, S 150, M 375, L 900, XL 2,250 (tractor force 6000 × size power, judged at 2 × dRef for 10 u/s²); field-rock re-split floor r160 1,206 / r260 3,186 / r480 10,857, all above XL. Owner asked for XL ≈ 22.6k (1/8 of the biggest rock): NOT applied, the force is shared with ship towing (2026-11-16 report) | `salvageTierMass`, `src/core/combat/salvageTargeting.ts`; `TRACTOR_DEF` | Which tractor pulls a piece; which laser size cuts it (matching size) | `salvageTargeting.test.ts`, `sizeLadder.test.ts` |
| Loot touch pickup | pod centre within 18 u (2 × cargo-pod radius) of the hull outline / shield bubble; a consumable wreck piece within its own radius | `LOOT_TOUCH_REACH`, `src/server/cargo/LootSubsystem.ts` (`shipWithinHullReach`) | Pods and small wreck pieces go in when they touch the hull | `LootSubsystem.test.ts`, `factoryLine.test.ts` |
| Tractor hold-zone pickup | 1.2 × the tractor's `hold` (300 u today) from the beam's muzzle | `TRACTOR_PICKUP_HOLD_MUL`, `src/server/rooms/ForceFieldSubsystem.ts` | A pod held in the collector's own tractor beam is picked up as if flown over | `tractorPickup.test.ts`, `ForceFieldSubsystem.test.ts` |
| Derelict TTL | 1 h | `DERELICT_TTL_MS`, `src/server/cargo/LootSubsystem.ts` | Abandoned-hull pods | `LootSubsystem.test.ts` |
| Storage capacity | Capital 5000, Cargo Bay 2000 (others per kind) | `StructureKind.holdCapacity`, `src/shared-types/structureKinds.ts` | Base storage | `StorageService.test.ts` |
| Auto-deposit | within 400 u (a freight dock: 900 u, its whole loading pad) for 120 ticks | `DEPOSIT_RANGE`, `depositRangeOf`, `DOCK_DEPOSIT_RANGE` (rigCatalogue.ts), `DEPOSIT_DWELL_TICKS`, `src/server/cargo/StorageService.ts` | When cargo deposits itself | `tests/integration/sectorRoom/storageDeposit.test.ts` |
| Standing scale | −100..100 in 0.1 steps; scale version 1 | `STANDING_SCALE_VERSION`, `src/server/economy/EconomyStore.ts` | Faction standing ([factions](factions.md)) | — |
| Packed item markup | × 1.3 on pack-recipe value | `PACKED_MARKUP`, `src/core/economy/market.ts` | Trader offers of packed structures | `tests/integration/sectorRoom/packedBuy.test.ts` |
| Packed hull offers | 2 on the board | `PACKED_HULL_OFFERS_ON_BOARD`, `src/server/economy/TradeDirector.ts` | Hull supply from traders | `tests/integration/sectorRoom/shipyard.test.ts` |

## History

Superseded values and the stories behind them, moved verbatim from `src/server/CLAUDE.md`
(2026-11-14). Links are rewritten for this folder. Other history stays with its subsystem, in the
"Server implementation notes" section of the guides linked above.

  - **LimboStore cap** (S8): RETIRED with the `LimboStore` (Phase 5/WS-B, 2026-06-14). The roster (`PlayerShipStore`) is the in-memory ship store now, bounded per player only by the 200-ship anti-abuse `ROSTER_SOFT_GUARD` (no gameplay cap) rather than a global entry cap.

- **Phase 4 — temporal plausibility**: fire claims older than `LAG_COMP_WINDOW` (12 ticks, ~200 ms) are **clamped** to the window floor and resolved against the oldest SnapshotRing pose — NOT rejected (changed 2026-05-19, capture `uf0o8g`: hard-rejecting dropped ~37% of a laggy client's shots when its wall-clock-anchored `inputTick` fell behind `serverTick` after a stall). Rewind stays bounded by `LAG_COMP_WINDOW` (no abuse advantage); the per-shooter cooldown is the separate, unchanged anti-rapid-fire guard. Pure helper: `clampFireTick` (`src/core/combat/fireTemporal.ts`).

- **Phase 4 — lag-comp buffer**: pre-allocated 1000 entities × 12 ticks × 16 bytes = 192 KB per sector. No per-tick allocation.

- **Wire format v3 (2026-05-09 AI lockstep)**: `SWARM_WIRE_VERSION = 3`. Per-record stride 33 bytes (was 29 in v2). Adds `f32 angvel` at offset +24 between `angle` and `radius`; shifts `radius` to +28 and `shipKind` to +32. Decoder hard-fails on `version !== 3` (no fallback). `SwarmEntityRegistry.poseChanged` now considers `|Δω| > 0.05 rad/s` as a delta-shipping trigger so spinning drones generate fresh packets even when stationary. `BinarySwarmBroadcast` zeroes `angvel` on SLEEPING records (parity with vx/vy). The field is required for client-side AI lockstep — without it the AI's `1.5·ω` damping term diverged between sides every tick. See [docs/architecture/ai-lockstep.md](ai-lockstep.md).
- **Drone snapshot slice (Phase C, 2026-05-09)**: `SnapshotMessage.drones?: Array<{ id, x, y, vx, vy, angle, angvel }>` ships the in-interest drone subset at `snap.serverTick`, sourced from `SnapshotRing.getPoseAt(id, serverTick)` so the poses are temporally aligned with `snap.states`. The client uses these to seed predWorld drone bodies before reconciler replay — the snapshot becomes the single source of truth for in-interest drones, and the binary swarm packet's `setShipState` is gated off for those drones to prevent dual-correction-path fighting. `SnapshotRing` extended from 5 to 6 floats per slot (480 KB → 576 KB per sector) to carry angvel through the lag-comp ring. Per-recipient interest reuses the `interestScratch` set already built by the swarm-broadcast block earlier in `update()` — no extra `query9` call.
- **Phase 6 — TiDi (superseded by the time scale, 2026-11-12: the cost rate now feeds `LoadSpeedController`, which slows the WHOLE sector through its game clock; `CLOCK_RATE` carries only `testTimeScale` and `state.clockRate` mirrors the load factor. The text below is the original mechanism)**: `SimulationClock` reports `totalMs` once per `update()`. Constants in `src/core/clock/SimulationClock.ts`: `OVER_BUDGET_MS = 14`, `WINDOW_TICKS = 30`, `RAMP_PER_TICK = 0.005` (1 s ramp from 1.0 → 0.7), hard `FLOOR = 0.7`. The room mirrors `clock.rate` to `state.clockRate` (Colyseus schema diff broadcasts to clients) and posts a `CLOCK_RATE` worker command only when the rate moves at least 1e-4 — keeps the worker queue clean. Single-writer rule: only the worker writes `CLOCK_RATE_IDX` in the SAB header; the server's only path to mutate it is the `CLOCK_RATE` postMessage.
