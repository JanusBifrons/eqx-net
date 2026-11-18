# CLAUDE.md — src/server (The Authority)

`src/server` is the absolute source of truth. The client runs prediction to hide latency, but the server's state is reality. Every piece of game logic runs here first, then gets broadcast. Read the root [CLAUDE.md](../../CLAUDE.md) for project-wide invariants before editing.

---

## Forbidden Imports (CI-enforced)

Never import from `src/server/`:

- UI / rendering: `pixi.js`, `pixi-viewport`, `react`, `react-dom`, `@mui/*`, `@emotion/*`, `howler`, `zustand`
- The client-side Colyseus package: `colyseus.js` (the server uses `colyseus`, not `colyseus.js`)
- Anything under `src/client/**`

Allowed: `colyseus`, `@colyseus/schema`, `@colyseus/ws-transport`, `express`, `zod`, `node:sqlite` (built-in, replaces `better-sqlite3`; see `docs/LESSONS.md`), `bcryptjs`, `jose`, `dotenv`, `pino` + `pino-pretty`, `src/core`, `src/shared-types`. `@colyseus/redis-driver` / `@colyseus/redis-presence` only if the multi-VM deployment shape is chosen.

---

## Authority Model

- Clients send **inputs**. The server decides **outcomes**. Never the other way around.
- Any state that matters is computed server-side. Client prediction and ghost projectiles are presentation tricks; they never influence authoritative state.
- The Colyseus `SectorRoom` owns one sector's physics world, AI, combat resolution, and broadcast path. Everything else (persistence, orchestration, galaxy registry) is a supporting service the room uses.

---

## Validation Contract (zod at the boundary)

- **Every** inbound message has a zod schema in `src/shared-types/`.
- Parse every message in `onMessage`. On failure: drop silently, increment a per-connection error counter, sampled `pino.warn`. Never throw to the game loop.
- Keep schemas strict (`.strict()`), no unknown keys.

---

## Thresholds and subsystem rules

Current values: [server-thresholds](../../docs/architecture/server-thresholds.md). A new threshold goes there, not here.
How each subsystem works (and its history) is in the "Server notes" section of the guide named per group.

**Security and inbound limits** ([security](../../docs/architecture/security.md)):
- Production is fail-closed: CORS is closed without `ALLOWED_ORIGINS` (`resolveCorsPolicy`), test rooms register only with `EQX_ENABLE_TEST_ROOMS=1` (`testRoomGating.ts`), and boot throws on a missing or placeholder `JWT_SECRET`.
- Auth endpoints are rate-limited per IP (429 + `Retry-After`); `/healthz` and `/diag` are not. Every inbound wire id is `.min(1).max(64)`; testMode seed arrays are bounded at `onCreate` (`MAX_SEED_ENTRIES`).
- Over-rate inputs (`MAX_INPUTS_PER_TICK`) and lock messages (`MAX_LOCK_MSGS_PER_TICK` via `lockMsgAllowed`) are silently dropped.

**Snapshots and lag compensation** ([snapshot-cadence](../../docs/architecture/snapshot-cadence.md#server-implementation-notes)):
- One snapshot cadence per recipient (`shouldBroadcastFar`), scheduled on `broadcastCounter`, never `serverTick`. Idle sectors suppress broadcasts; the join grace forces them after a join/spawn/reconnect.
- Backpressure drops the oldest snapshot, then force-closes; the lag-comp ring is pre-allocated. A fire claim older than `LAG_COMP_WINDOW` is clamped (`clampFireTick`), never rejected. NPC locks stay in budget.

**Load** ([game-time-scale](../../docs/architecture/game-time-scale.md)):
- Load shedding removes only kind-1 drones outside EVERY connected player's view (`loadShedOutOfView.test.ts`); in-view load is carried by the slowdown. Never shed `shedImmune`, elite or event NPCs.
- A shed despawns quietly (`evictSwarmEntity({ broadcast: false, emitDestroyed: false })`, no `ENTITY_DESTROYED`) and emits `ENTITY_SHED`. Only the worker writes `CLOCK_RATE_IDX`; the server's path is the `CLOCK_RATE` message.

**Persistence and roster** ([persistence-and-migrations](../../docs/architecture/persistence-and-migrations.md#server-implementation-notes)):
- The `dbWorker` is the sole DB writer via `IPersistenceSink`; the main thread opens the DB read-only. Stop a Windows dev server with `POST /dev/shutdown`.
- Reconnect and transit arrival restore from the roster through the one `onJoin` shipId-restore path. Persistence is opt-out per kind (`SectorPersistence.persist()`); never key on entity ids across a restart.
- A schema bump reseeds every sector; new `player_ships` columns use `PLAYER_SHIPS_MIGRATIONS`. Editing `SHIP_KINDS` numbers bumps `SHIP_KIND_CATALOGUE_VERSION`. Sectors are created eagerly at boot.

**Transit** ([travel-state](../../docs/architecture/travel-state.md), [configurable-arrival](../../docs/features/configurable-arrival.md)):
- During the spool the ship stays in the source room, damageable; its destruction aborts the transit. Commit reads the SAB pose, not the schema. Engineering rooms (`sectorKey === null`) have no transit or linger.
- An `arrival` point overrides only x/y and is clamped (`clampToSectorBounds`). A transit `shipId` is ownership-checked before the state machine starts (foreign or unknown ⇒ reject).
- Look up a player's active hull with `resolveActiveShipKey(playerId)`; snapshot `states` are keyed by `shipInstanceId` ([sector-room-anatomy](../../docs/architecture/sector-room-anatomy.md)).

**Leveling and mounts** ([leveling-and-upgrades](../../docs/architecture/leveling-and-upgrades.md#server-implementation-notes), [weapon-mounts](../../docs/architecture/weapon-mounts.md)):
- 🔴 Progression belongs to the ship INSTANCE; only player killers earn XP. Upgrade/respec/activate messages check ownership then budget; invalid is a silent no-op.
- 🔴 Physics multipliers apply only in `applyShipInput` (server worker and client predWorld alike); other multipliers are server-authoritative at every hull-seed site (`effectiveShip*`).
- Mount geometry comes only from the `slots.ts` resolvers, never the wire. Own-ship slim fields are own-only and emit-when-non-empty.

**Living world** ([living-world](../../docs/architecture/living-world.md#server-implementation-notes), [wave-attacks](../../docs/features/wave-attacks.md), [living-galaxy](../../docs/architecture/living-galaxy.md)):
- The director owns bot lifecycle; a quiet despawn never emits `ENTITY_DESTROYED`. Hostility only via `markHostile` + `bot_aggro` and the `FactionLedger`. Null-guard every director reference.
- 🔴 Entry-only ingress: from-nowhere drone spawns only at a galaxy entry sector edge; squads traverse hop by hop. 🔴 `warp_warning` comes only from the `IncomingRegistry`.
- 🔴 Flock roles come from the director, steering per tick in the drone brain. Director persistence runs on the control loop, never in `update()`.

**Allegiances and friendly fire** ([allegiances](../../docs/architecture/allegiances.md#server-implementation-notes)):
- 🔴 Classify by the registry kind, never an id prefix. `isHostileToPlayer` = stance OR ledger; only a hit on a DRONE escalates the `FactionLedger`. Allegiance decides targeting, never what a shot hits.
- 🔴 Every shot hits the first thing in its path, own side included (skips: shooter, a capital's own deck, loot pods for non-pilot shots and mining tools); friendly hits never mark hostile.
- AI pilots (AI-flown owned hulls too) hold fire on a friendly line only via `LineOfFireGate`; players are never gated. Drone-brain proximity queries use `AiNeighbourGrid`.

**Cargo and storage** ([loot-and-cargo](../../docs/features/loot-and-cargo.md#server-implementation-notes)):
- 🔴 Value only moves (`transferInto`), never copies; every transfer is ONE atomic `GROUP`; `HoldStore` is the authority. Every death and abandon seam spills the hold.
- Loot pods spawn directly, never via `ScrapSpawner`. `StorageService` is the one store of value for storage. 🔴 AI targets ACTIVE, disconnected and displaced lingering hulls, never a pending-join hull.

**NPC sides** ([robots](../../docs/features/robots.md), [robot-territory](../../docs/features/robot-territory.md), [bounties-and-events](../../docs/features/bounties-and-events.md)):
- 🔴 Classify a director bot id with `isDirectorBotId`, never a prefix literal (a new director adds its prefix there). The robot director persists to its own `allegiance_director_state` row.
- Only the robot director gets a `respawnAnchor`. Rock ore leaves only through `OreDraw` (harvesters via `SectorRoom.mineAsteroid`; the mining laser pays only through its cut pieces' pods, `cutYield`); a raid step is one `StorageService.tradeTransfer` group. Charge weapons fire via `releaseCharges`; `evictSwarmEntity` forgets the shooter.
- 🔴 An elite is a tag on the swarm record (`markElite`), never a new kind; every per-entity max hull goes through `droneMaxHealthOf`. Elites and event NPCs are never load-shed.

**Economy** ([economy-and-trade](../../docs/architecture/economy-and-trade.md#server-implementation-notes), [economy-wallet](../../docs/features/economy-wallet.md), [blueprints](../../docs/features/blueprints.md), [research-lab](../../docs/features/research-lab.md)):
- 🔴 Each trade visit is ONE `tradeTransfer` group; an NPC hold spills on death, so a kill never mints value. NPC→player hostility is `SectorRoom.npcHostileTo`.
- Credits never live in a `Hold`: every source/sink goes through the `Wallet` (all-or-nothing; `creditDeferred` / `debitDeferred` when atomic with goods). Guests are full players.
- Blueprint maths only via `applyBlueprint`; packed items only via `addPacked` / `takePacked`; prices only from `blueprintValue`; `qualityHullFactor` is the one quality source. Lab rules live in `shared-types/research.ts`.

**Capital combat** ([capital-ships](../../docs/features/capital-ships.md#server-implementation-notes), [shell-events](../../docs/architecture/shell-events.md), [real-scale-ranges](../../docs/architecture/real-scale-ranges.md)):
- 🔴 No hull-aimed salvo: each mount picks and leads its own target (`mountTargeting.ts`) and fires when reloaded, in reach (`mountTargetReach`) and on bearing.
- Naval shells travel only as `ShellEventHub` events, never in `projectiles[]`. `EQX_NAVAL_RANGE` is read once per process and stamped on the welcome.

---

## Structure network at base scale

- **Generated bases** place with `skipAutoConnect: true` and link with `connectExplicit`; players never pass `skipAutoConnect`.
- **`StructureState` fields** have no initialiser and are assigned only on change and away from `STRUCTURE_DEFAULTS`. Budgets live in `structureBudgets.ts`; test layouts only in `rooms/scenarioLayouts.ts`.
- Full text and locks: [structures guide](../../docs/architecture/structures-and-power-grid.md#server-implementation-notes), [scale ledger](../../docs/architecture/structure-network-scale.md).

## Production

- **`ProductionSubsystem`** runs on the 1 Hz pulse before `storage.flushDirty()`, all-or-nothing in and out, allocation-free. Blueprint slots move only via `StorageService` slot methods.
- **Drills** never mine into a full network; turrets `spendAmmo` before every shot. Power switches only via `StructureGridSubsystem.setActive`. Credits outputs pay the wallet (`payCredits`). A fence blocks its owner's fire.
- Full text and locks: [production-chains.md](../../docs/architecture/production-chains.md#server-implementation-notes).

## Cargo access

- **Gate:** `cargoAccess` (`rooms/features/cargoMessages.ts`) is re-checked on every `cargo_query` / `cargo_move`; moves only via `StorageService.cargoTake` / `cargoPut` / `marketBuy` / `marketSell`.
- **Break-ins** are hostile acts; an NPC's loot is rolled once per spawn (`npcHold`).
- Full text and locks: [loot-and-cargo.md](../../docs/features/loot-and-cargo.md#server-implementation-notes).

## NPC bases, convoys and transit links

- **Order:** galaxy bases seed after `hydrateFromSnapshot`, alien gates after the bases. NPC structures are regenerated, not persisted. `ConvoyDirector` runs on its 1 s loop; trade quotes via `TradeDirector.quote`.
- **Link teleporters** pair through `findLinkTwin`, never by position.
- Full text and locks: [procedural-bases.md](../../docs/architecture/procedural-bases.md#server-implementation-notes), [economy-and-trade.md](../../docs/architecture/economy-and-trade.md#server-implementation-notes), [transit-hubs.md](../../docs/features/transit-hubs.md#server-implementation-notes), [military-bases.md](../../docs/features/military-bases.md#server-implementation-notes).

## Teleporters and alien gates

- **Pad holds** move only via the `StorageService.pad*` methods. Director bots cross only via `TeleportBroker.moveBot`. Only the asked teleporter's owner accepts a pair request.
- **Alien gates** are unbuildable and invulnerable; pair only via `findAlienTwin`.
- Full text and locks: [teleporters.md](../../docs/features/teleporters.md#server-implementation-notes), [alien-gates.md](../../docs/features/alien-gates.md#server-implementation-notes).

## Fire control: lock-to-fire is universal (root invariant #19)

- **Every player is tracked** by `LockSubsystem` from join to leave. A group fires only with a LOCKED target and only mounts passing `mountFiresOn` (reach + bearing); none ⇒ `hit_ack { rejected }`, nothing spent.
- **Player mounts aim only at their group's lock**, else home. Every self-chosen target ranks by `mountPriority`. Player and NPC share ONE `lockSeconds` path (no per-pilot flag). `lock_track` is verified with `lockLineHolds`.
- **Locks work at any distance; only firing is range-limited.** Locks and attacks keep hostility alive, never create it. Tests use the lock triggers, never a fire bypass.
- **NPC drones, NPC capital turrets and structure turrets fire only with a completed lock**; their range is per mount to the target's hull via `mountInReach`. An AI shot leaves its drawn barrel. Spectating doesn't dodge a fight.
- Full text and locks: [fire-control.md](../../docs/architecture/fire-control.md#server-implementation-notes).

## Defence fire control (plan coastal-defences)

- **Structure turrets lock to fire (#19):** each mount fires only with a COMPLETED lock on its current target (`STRUCTURE_SENSOR`, `clampAtMax`). The server is the only writer of structure mount angles (#12). Lock: `StructureMountTicker.test.ts`.
- **A shell that hits nothing ends silently:** no burst, no splash, no `shell_end`. Lock: `tests/unit/navalShellMissParity.test.ts`.
- Detail: [coastal-defences.md](../../docs/features/coastal-defences.md#server-implementation-notes).

## Faction standing and NPC ownership

- **Standing hits:** `applyDamage` → `noteStandingHit` is the one path; don't add standing deltas elsewhere without a reason (trade keeps its own `REP_*`). Lock: `factionStanding.test.ts`. Detail: [factions.md](../../docs/architecture/factions.md#server-implementation-notes).
- **Hostility:** every "is this hostile?" decision about a structure goes through `relationOf` with the room's ONE `relationCtx`; never compare owner strings inline. NPC owners (`npc:<allegiance>:<baseId>`) are excluded from player-faction systems. Lock: `npcOwnership.test.ts`. Detail: [relations.md](../../docs/architecture/relations.md#server-implementation-notes).

## Player identity is account-bound

- **Never trust a client-claimed `playerId` for a logged-in session** (`resolveForUser`). A new server-side seat reservation uses `issueTransitIdentity` / `consumeTransitIdentity`; a new persisted playerId goes through `canonicalPlayerId()` on load. E2E fixture accounts keep per-browser ids.
- Locks: `accountBoundPlayerId.test.ts`, `account-bound-identity.spec.ts`, `accountIdentity.test.ts`. Detail: [player-identity.md](../../docs/architecture/player-identity.md#server-implementation-notes).

## Game time is the default

- **Inside a room** read `this.gameClock.now()` and schedule with `this.gameClock.after` / `.every`; outside, use `gameNow()` / `gameSetTimeout` / `gameSetInterval`. Subsystems take `now` deps defaulting to `gameNow`.
- **Saved timestamps are game time** (`gameNow()` stamps in holds, wallets, directors, economy): they drift from wall time while the speed isn't 1×; never mix in a `Date.now()` stamp.
- **Real time** only for a file on the `eslint.config.js` allowlist or a line with `// eslint-disable-next-line no-restricted-properties -- real time: <why>`; never to dodge the rule. Detail: [game-time-scale.md](../../docs/architecture/game-time-scale.md#server-implementation-notes).

## Pino Sampling Policy

- Dev: `pino-pretty` transport.
- Prod: JSON to stdout (Fly.io captures).
- High-frequency events (`LASER_FIRED`, `ENTITY_WOKE` storms, reconciliation drifts): sample at **1 %**.
- Discrete lifecycle events (join/leave, transit state changes, sector spin-up/-down): **full fidelity**.
- Never log position/velocity data.

## Gameplay audit log (`src/server/audit/`)

- **`auditEvent(evt)` only at discrete boundaries** (destruction, dispatch, shield 0-cross, join), never in a per-tick / per-hit loop; throttle a rapid boundary. Add new events to the hook inventory in the guide.
- **The write path is not dev-gated** (only `GET /dev/audit` is). Under vitest the sink is a no-op; tests capture via `setAuditSink`. Keep `scripts/query-audit.mjs` filters aligned with `auditQuery.ts`. Lock: `structureDestroyedAudit.test.ts`.
- Detail: [gameplay-audit-log.md](../../docs/architecture/gameplay-audit-log.md#server-implementation-notes).

---

## Combat Architecture

- **Lag-comp hit tests are pure geometry** (`rayHitsSphere` on `SnapshotRing`), never Rapier `castRay`. Stale fire claims are clamped, never rejected. Projectiles step by worker ticks.
- **Adding a weapon never edits `SectorRoom.ts`**, only the catalogue. Swarm hits go through `ProjectileBroadphase` (must equal the full scan).
- **Every cleanup path clears `playerMountAngles` and `droneMountAngles`** with `lastFireClientTick`. Drones target active hulls only.
- Full text and locks: [sector-room-anatomy.md](../../docs/architecture/sector-room-anatomy.md#server-implementation-notes), [weapon-mounts.md](../../docs/architecture/weapon-mounts.md#server-implementation-notes).

## Fleet command (RTS)

- **`SectorRoom.shipKeyMoved` is THE one re-key seam** when a ship's key moves (locks, fleet orders, turret angles); never add a second. An owned hull is flown by the AI pilot brain, registered `{ hull: true }` (keys as pilot INPUT); it fires through `PlayerFireResolver` on its brain's `intent.fire`, never `AiFireResolver`; fleet commands are owner-checked per id. Detail: [fleet-command](../../docs/architecture/fleet-command.md#7-zone-rules-in-full).

## SectorRoom subsystems

- **State lives on the subsystems; integration tests reach private state only through `SectorRoom._internals`**, never local cast interfaces. Detail: [sector-room-anatomy.md](../../docs/architecture/sector-room-anatomy.md#subsystem-map), [`_internals`](../../docs/architecture/sector-room-anatomy.md#_internals-test-accessor).

## Threading

- **A new CPU-heavy subsystem defaults to a worker**, not the main thread. Physics runs on `PhysicsWorkerPool` (several sector worlds per worker); sqlite writes run on their own worker. Navigation maps and route searches run on the one nav worker (`nav/NavWorker.ts`, [navigation](../../docs/architecture/navigation.md)). Detail: [sector-room-anatomy.md](../../docs/architecture/sector-room-anatomy.md#threading).

## Testing patterns

- **Decision logic over state:** hand-rolled mocks (`src/server/transit/TransitOrchestrator.test.ts` is the model).
- **Anything on the snapshot wire or broadcast gates, and every new visible entity type:** an integration test on `tests/integration/sectorRoom/harness.ts` (`pnpm test:integration`).
- **A test that needs a live hull uses `harness.connectActive`** (sends `client_ready`); `connectAs` alone never activates. Detail: [DETERMINISM.md](../../tests/integration/sectorRoom/DETERMINISM.md#server-testing-patterns).

## Generic Entity Pipeline

- **A new damageable type is a leaf + a registry row**, never a dispatch branch; `applyInteraction` stays ONE monomorphic function. A new pose-core kind is a swarm-registry record (seed `swarmHealth` to be damageable).
- **Entity-sync sends go through `EntitySyncRouter.route`**; a byte change needs the netgate.
- Full text and locks: [generic-entity-pipeline.md](../../docs/architecture/generic-entity-pipeline.md#server-implementation-notes).

## Structures: placement, power grid, shield fence

- **Placement checks structures AND asteroids** via `canPlaceStructureAt`; `remove` is owner-gated. Grid changes touch the snapshot path: netgate.
- **Shield-wall bodies live in `PhysicsWorld.wallBodies`**; a pylon with an active wall takes no damage.
- Full text and locks: [structures-and-power-grid.md](../../docs/architecture/structures-and-power-grid.md#server-implementation-notes).

## Abandon → scrap or wreck

- **An abandoned hull (active or lingering) breaks up exactly as its death would** (`spawnCapitalWreck` then `spawnHullScrap`) and leaves the world. The lingering path is `shipInstanceId`-keyed and never touches a `playerId`-keyed map. Locks: `abandonToScrap.test.ts`, `abandonLingeringToScrap.test.ts`, `abandonCapitalToWreck.test.ts`. Detail: [composite-ships-and-scrap.md](../../docs/architecture/composite-ships-and-scrap.md#server-implementation-notes).

## Same-sector instant pilot swap — `pilot_ship`

- **Reclaims only the requester's own lingering hull in this room** (anything else is a silent no-op), displaces any active hull first, and re-drives the unified join handshake: no second activation path (#12). Netgate required. Lock: `pilotInSectorShip.test.ts`. Detail: [spectator-and-construction-mode.md](../../docs/architecture/spectator-and-construction-mode.md#server-implementation-notes).

## Shield/Hull + ramming

- **Shield values reach clients on discrete events only** (`DamageEvent`, `ShieldEventMessage`); the regen ramp is never streamed.
- **Ram damage is rounded before the emit guard** (a sub-0.5 hit emits nothing); contact → damage is live-loop, so netgate. Lock: `ramming.test.ts`. `feel-test-lockstep.spec.ts` is host-load sensitive: confirm on a quiet host or CI.
- Detail: [shield-hull.md](../../docs/features/shield-hull.md#server-implementation-notes).

## Scrap-on-death

- **Every death path spawns scrap BEFORE the slot is freed**; a dying scrap piece never re-shatters. Scrap is saved in the sector snapshot and FIFO-capped; battle wrecks are saved as lineage rows (`wreckLineageSaves.ts`), never in the snapshot; wire changes need the netgate. Locks: `ScrapSpawner.test.ts`, `scrapOnDeath.test.ts`, `lingeringScrapOnDeath.test.ts`. Detail: [composite-ships-and-scrap.md](../../docs/architecture/composite-ships-and-scrap.md#server-implementation-notes).

## Capital wrecks

- **Break-up is ON by default** (`wreckSwitchOn`; a room opts out, `EQX_*_WRECKS=0` forces off); one death effect per ship.
- **Wreck pieces (kind 4) block every weapon but the railgun slug**: a new hit path handles kind 4. Snapshots carry wreck deltas only.
- Full text and locks: [capital-destruction.md](../../docs/architecture/capital-destruction.md#server-implementation-notes).

## Solar-system sectors

- **Place arrivals, convoys, elites and events by pocket**; with no pockets fall back to `HOME_POCKET_HALF_EXTENT`, never `SECTOR_PLAYABLE_HALF_EXTENT`. Detail: [solar-system-sectors.md](../../docs/architecture/solar-system-sectors.md#server-implementation-notes).

## Flagship fleets

- **Escort stations come from hull radii (`escortRing`)**, never a flock distance; `warpBot` lands at `landingPoint`; `flagship-` ids are never shed. Kill switch `EQX_DISABLE_FLAGSHIPS`. Detail: [capital-ships.md](../../docs/features/capital-ships.md#server-implementation-notes).
