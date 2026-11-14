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

## Thresholds and subsystem rules

Current values: [server-thresholds](../../docs/architecture/server-thresholds.md). A new threshold goes there, not here.
How each subsystem works (and its history) is in the "Server notes" section of the guide named per group.

**Security and inbound limits** ([security](../../docs/architecture/security.md)):
- Production is fail-closed: CORS is closed without `ALLOWED_ORIGINS` (`resolveCorsPolicy`), test rooms register only with `EQX_ENABLE_TEST_ROOMS=1` (`testRoomGating.ts`), and boot throws on a missing or placeholder `JWT_SECRET`.
- Auth endpoints are rate-limited per IP (429 + `Retry-After`); `/healthz` and `/diag` are not. Every inbound wire id is `.min(1).max(64)`; testMode seed arrays are bounded at `onCreate` (`MAX_SEED_ENTRIES`).
- Over-rate inputs (`MAX_INPUTS_PER_TICK`) and lock messages (`MAX_LOCK_MSGS_PER_TICK` via `lockMsgAllowed`) are silently dropped.

**Snapshots and lag compensation** ([snapshot-cadence](../../docs/architecture/snapshot-cadence.md)):
- One snapshot cadence per recipient (`shouldBroadcastFar`, per-client phase offset); never two cadences (their union gives irregular intervals). Schedule on `broadcastCounter`, never `serverTick`.
- Idle sectors suppress broadcasts; the join grace forces them after every join, spawn or reconnect (`joinBroadcastGrace.test.ts`). `lastInput` is omitted when unchanged for that recipient.
- Backpressure drops the oldest queued snapshot, then force-closes. The lag-comp ring is pre-allocated (no per-tick allocation); the swarm encoder runs per client inside the backpressure loop.
- A fire claim older than `LAG_COMP_WINDOW` is clamped to the window floor (`clampFireTick`), never rejected; the per-shooter cooldown stays the separate anti-rapid-fire guard.
- The NPC lock step stays inside its budget (`benchmarks/npc-locks.bench.ts`).

**Load** ([game-time-scale](../../docs/architecture/game-time-scale.md)):
- Load shedding removes only kind-1 drones outside EVERY connected player's view (`loadShedOutOfView.test.ts`); in-view load is carried by the slowdown. Never shed `shedImmune`, elite or event NPCs.
- A shed despawns quietly (`evictSwarmEntity({ broadcast: false, emitDestroyed: false })`, no `ENTITY_DESTROYED`) and emits `ENTITY_SHED`. Only the worker writes `CLOCK_RATE_IDX`; the server's path is the `CLOCK_RATE` message.

**Persistence and roster** ([persistence-and-migrations](../../docs/architecture/persistence-and-migrations.md)):
- The `dbWorker` is the sole DB writer; every write goes through `IPersistenceSink` (CRITICAL or VOLATILE lane); the main thread opens the DB read-only. On Windows dev, stop the server with `POST /dev/shutdown`.
- Reconnect and transit arrival both restore from the roster (`PlayerShipStore`) through the one `onJoin` shipId-restore path; there is no `LimboStore`. A lingering hull stays until combat, respawn-evict or abandon.
- Persistence is opt-out per kind in `SectorPersistence.persist()`: structures, scrap and lingering hulls persist; projectiles never; drones belong to the director. Re-derive adjacency and scrap colliders on hydrate; never key on entity ids across a restart.
- Bumping `CURRENT_SCHEMA_VERSION` tears down and reseeds every sector. New `player_ships` columns go through the idempotent `PLAYER_SHIPS_MIGRATIONS`; JSON columns parse defensively.
- A PR that edits numeric fields in `SHIP_KINDS` bumps `SHIP_KIND_CATALOGUE_VERSION` by 1; a mount-layout change needs its own migration story.
- Galaxy sectors are created eagerly at boot and simulate with no players; the broadcast loop skips an empty room.

**Transit** ([travel-state](../../docs/architecture/travel-state.md), [configurable-arrival](../../docs/features/configurable-arrival.md)):
- During the spool the ship stays in the source room, damageable; its destruction aborts the transit. Commit reads the SAB pose, not the schema. Engineering rooms (`sectorKey === null`) have no transit or linger.
- An `arrival` point overrides only x/y and is clamped (`clampToSectorBounds`). A transit `shipId` is ownership-checked before the state machine starts (foreign or unknown ⇒ reject).
- Look up a player's active hull with `resolveActiveShipKey(playerId)`; snapshot `states` are keyed by `shipInstanceId` ([sector-room-anatomy](../../docs/architecture/sector-room-anatomy.md)).

**Leveling and mounts** ([leveling-and-upgrades](../../docs/architecture/leveling-and-upgrades.md), [weapon-mounts](../../docs/architecture/weapon-mounts.md)):
- 🔴 XP, stat allocation and activated mounts belong to the ship INSTANCE; only player killers earn XP; a destroyed ship's roster row (all progression) is deleted.
- `apply_ship_upgrade` / `respec_ship` / `activate_mount` / `upgrade_structure`: check ownership, then budget or slot; anything invalid is a silent no-op. The stat budget can never be exceeded.
- 🔴 Physics multipliers apply only in `applyShipInput`, identically on the server worker and client predWorld. Other multipliers are server-authoritative at every hull-seed site (`effectiveShip*`); a live respec clamps down (no free heal); `mul.damage` scales player weapons only.
- Activated-mount geometry comes only from the `slots.ts` resolvers, never the wire. `effectiveStructureMaxHealth` is the one structure max-HP helper; a structure upgrade reuses the build phase; turret reach is never levelled.
- Own-ship slim snapshot fields (`statAlloc`, `cargo`, `depositing`, `wallet`, `fitted`) are own-only and emit-when-non-empty (#16, no wire bump).
- A mid-upgrade Capital stays a funding source and route source (`structureUpgradeCapital.test.ts`).

**Living world** ([living-world](../../docs/architecture/living-world.md), [wave-attacks](../../docs/features/wave-attacks.md), [living-galaxy](../../docs/architecture/living-galaxy.md)):
- The director owns bot lifecycle. A quiet despawn never emits `ENTITY_DESTROYED` (its respawn trigger). Hostility uses `markHostile` + `bot_aggro`; no proactive hostility branch or wire flag. Null-guard every director reference (`EQX_DISABLE_LIVING_WORLD`).
- Drones go hostile only through the `FactionLedger` (a wave against a ready base, or a member hitting a drone); a player with no base is not hunted. A ready base draws waves whether or not its owner is present; a wave is time-boxed. 🔴 Drones prefer structures via `pickTarget` `priorityBias` (server-only).
- 🔴 Entry-only ingress: a from-nowhere drone spawn happens only at a galaxy entry sector, at the edge, never on top of a player. Squads traverse hop by hop; with zero hop travel a hop is an atomic despawn/spawn.
- Wave members landing at their target are marked hostile inline; a wave hop lands at the clamped carry pose, a roam hop at the shared squad edge pose (`squadEdgePose`).
- 🔴 `warp_warning` comes only from the `IncomingRegistry` (the hop choke point `startSquadMemberTransit`, plus player transit); never add a second source.
- 🔴 Flock roles are assigned by the director; steering is per tick in the drone brain (`resolveEntityInto`); server-only, no wire bump. Flock and spool numbers are feel knobs: confirm on device. `livingWorldFormation.test.ts`.
- Director persistence and galaxy stats run on the control loop, never in `update()`. The drone director is the only `/galaxy/snapshot` provider and incoming-player sink.

**Allegiances and friendly fire** ([allegiances](../../docs/architecture/allegiances.md)):
- 🔴 Classify by the registry kind, never an id prefix. `fillSwarmTargets` builds the cross-allegiance view once per tick, only with ≥ 2 allegiances present. `isHostileToPlayer` = stance OR ledger. Only a hit on a DRONE escalates the `FactionLedger`.
- `npcOnly` kinds are refused on join (`isPlayableShipKindId`); `LoadShedder` skips `shedImmune` kinds. Allegiance decides targeting, never what a shot hits.
- 🔴 Every shot hits the first thing in its path, own side included; the only skips are the shooter and a capital's own deck (`mountLineClear`). A friendly accidental hit damages but never marks hostile or escalates (`isFriendlyFire`).
- NPCs hold fire while a friendly (or, for an NPC ship, a wreck piece) is on the line, only via `LineOfFireGate` (never a second scan); players are never gated. `friendlyFire.test.ts`, `npcLineOfFire.test.ts`.
- Proximity queries in the drone brain go through `AiNeighbourGrid`, never a per-behaviour swarm scan (`AiNeighbourGrid.test.ts`).

**Cargo and storage** ([loot-and-cargo](../../docs/features/loot-and-cargo.md)):
- 🔴 Value only moves (`transferInto`), never copies; every transfer is ONE atomic `GROUP` of absolute `HOLD_PUT` / `HOLD_DELETE`; `HoldStore` is the authority. Every death and abandon seam spills the hold.
- Loot pods are spawned directly (never via the `ScrapSpawner` FIFO, never in the sector snapshot) and restored from `holds`. Only an ACTIVE, alive hull with a roster row collects.
- A structure's hold is keyed by its deterministic `uid`. `StorageService` is the one store of value for storage; a storage hold is owner-only on `entity_stats`; storage leaving the world spills.
- 🔴 AI targets ACTIVE, disconnected and displaced lingering hulls; a connected inactive hull (pending join) is untargetable (#17). `storageDeposit.test.ts`, `lingeringAiTargetable.test.ts`.

**NPC sides** ([robots](../../docs/features/robots.md), [robot-territory](../../docs/features/robot-territory.md), [bounties-and-events](../../docs/features/bounties-and-events.md)):
- 🔴 Classify a director bot id with `isDirectorBotId`, never a prefix literal (a new director adds its prefix there). The robot director persists to its own `allegiance_director_state` row.
- Only the robot director gets a `respawnAnchor`. Harvesters mine only through `SectorRoom.mineAsteroid`; a raid step is one `StorageService.tradeTransfer` group. Charge weapons fire via `releaseCharges`; `evictSwarmEntity` forgets the shooter.
- 🔴 An elite is a tag on the swarm record (`markElite`), never a new kind; every per-entity max hull goes through `droneMaxHealthOf`. Elites and event NPCs are never load-shed.

**Economy** ([economy-and-trade](../../docs/architecture/economy-and-trade.md), [economy-wallet](../../docs/features/economy-wallet.md), [blueprints](../../docs/features/blueprints.md), [research-lab](../../docs/features/research-lab.md)):
- 🔴 Each trade visit's value moves are ONE `tradeTransfer` group, with its `TRADE_DEAL_PUT` in the same commit. Any NPC carrying a hold spills it on death, so a kill never mints value; value changes hands only on safe departure, and a raid refunds the escrow. The one NPC→player hostility query is `SectorRoom.npcHostileTo`.
- Haulers are not persisted; `TradeDirector.reconcile()` runs at boot before `start()`. Standing reads go through `EconomyStore.standing` / `TradeSink.standing`.
- Credits never live in a `Hold`; every source credits and every sink debits the `Wallet` (all-or-nothing). A credit move atomic with goods uses `creditDeferred` / `debitDeferred` in the same commit group. Guests are full players (no sign-in gate). Trade refunds wallet-paid credits on every unwind.
- Blueprint maths only through `applyBlueprint`; packed items move only via `addPacked` / `takePacked`; market prices only from `blueprintValue`; buy/sell commits storage + wallet as one group.
- A fresh galaxy spawn of a non-starter hull downgrades to `DEFAULT_SHIP_KIND`. `qualityHullFactor` is the one quality source, at every max-hull site.
- Unpacking a hull: check the roster cap, take the crate, then create the row (put the crate back on failure). Packed-gate builds commit only after the structure registers; starter kinds and generated builds skip it. A prepaid structure reclaims no minerals: it repacks.
- A lab job holds its blueprints; start commits storage, job and fee as one group. Installed blueprints are a `fitted` hold, installed in one group (`installBlueprint`), dropped by `spillOrLoseShipHold`. Lab rules live only in `shared-types/research.ts`; its panel is rebuilt from `lab_state` only.

**Capital combat** ([capital-ships](../../docs/features/capital-ships.md), [shell-events](../../docs/architecture/shell-events.md), [real-scale-ranges](../../docs/architecture/real-scale-ranges.md)):
- 🔴 Capitals never fire as a hull-aimed salvo; each mount leads its own target and fires only when reloaded, in reach and on bearing. Each turret picks its own target (`mountTargeting.ts`); targeting only, shells hit whatever they meet.
- Turret reach comes from `mountTargetReach` on the server player, drone and client aim paths (#15). A capital given a guard post keeps station inside its radius; a director that spawns a defending capital posts it.
- Naval shells travel only as `ShellEventHub` events, never in `projectiles[]`; route new viewer rules through the hub. A capital and its shells are WIDE interest entities.
- `EQX_NAVAL_RANGE` is read once per process; the server stamps it on the welcome (`stampNavalRange`). Far drones' slim slice and the drone `swarm-<id>` wire owner are snapshot-only views.
- Locks: `tests/unit/capitalCombat.test.ts`, `tests/integration/sectorRoom/capitalEngagement.test.ts`.

---

## Structure network at base scale

- **Generated structures use the real rules:** a generated base places with `place(…, { skipAutoConnect: true, rot })` and links with `connectExplicit` (re-checks `canConnect`); never auto-connect one (it would close gates). Players never pass `skipAutoConnect`.
- **Structure room state (A2 rules):** a `StructureState` field has no initialiser and is assigned only on change and only away from `STRUCTURE_DEFAULTS` (compare `(st.f ?? DEFAULT) !== value`). Production and teleporter fields follow the same rule.
- **Budgets and layouts:** structure-heavy content stays inside `src/shared-types/structureBudgets.ts`. Test layouts live only in `rooms/scenarioLayouts.ts`; re-derive hand-placed ones against the real footprint boxes. Only ACTIVE player ships open gates (#17). Lock: `structureRotation.test.ts`.
- Detail: [structures guide](../../docs/architecture/structures-and-power-grid.md#structure-network-at-base-scale), [scale ledger](../../docs/architecture/structure-network-scale.md).

## Production

- **Production:** `ProductionSubsystem` runs on the 1 Hz pulse before `storage.flushDirty()`; inputs are taken all-or-nothing at cycle start, outputs put all-or-nothing at the end; it stays allocation-free (0.3 ms per pulse at 60 processors). `set_recipe` is owner-gated.
- **Blueprint slots:** move a blueprint only via `StorageService.loadBlueprint` / `unloadBlueprint` / `takeSlotForSpill` (one hold group each). Only the player's `place_structure` passes `requirePacked: true`.
- **Drills and ammo:** a drill never mines into a full network (`canDepositGoods`); a turret calls `spendAmmo` before every shot and holds fire with none (`rec.noAmmo`). Locks: `extraction.test.ts`, `ProductionSubsystem.test.ts`, `production.test.ts`.
- **Active power:** `StructureGridSubsystem.setActive(rec, active)` is the one switch; never write `rec.drawFull`. A new power consumer that works must call it.
- **A fence blocks its owner's own fire.** Lock: `turretVsOwnFence.test.ts`. Mines live in room state (#16); `mine_detonated` is only an accelerator ([mine-layer](../../docs/features/mine-layer.md)).
- **Credits outputs** pay a PLAYER owner's wallet via `payCredits`; never put credits in a hold.
- Detail: [production-chains.md](../../docs/architecture/production-chains.md#server-implementation-notes).

## Cargo access

- **Gate:** `SectorRoom.cargoAccess` (relation, live ACTIVE ship #17, `CARGO_ACCESS_RANGE`) is re-checked on every `cargo_query` / `cargo_move`.
- **Moves:** only via `StorageService.cargoTake` / `cargoPut` / `marketBuy` / `marketSell` (one hold group each, wallet ops as `extraOps`); never let a market fill skip `recordDockFill`. A manual move sets `manualCargo` (auto-deposit off).
- **Break-ins and ship cargo:** starting a break-in is a hostile act and any hit cancels it; an NPC's loot is rolled once per spawn (`npcHold`), so stolen loot never drops twice. Standing-order wallet ops land in the same group as the goods. Lock: `cargoAccess.test.ts`.
- Detail: [loot-and-cargo.md](../../docs/features/loot-and-cargo.md#server-implementation-notes).

## NPC bases, convoys and transit links

- **Order:** galaxy bases seed AFTER `hydrateFromSnapshot`, and alien gates AFTER the bases; keep it. NPC structures are not persisted (regenerated from the seed). Kill switches `EQX_DISABLE_NPC_BASES=1`, `EQX_DISABLE_CONVOYS`. Lock: `galaxyBases.test.ts`.
- **Convoys:** `ConvoyDirector` runs on its 1 s unref'd loop, never the 60 Hz tick; every value move is ONE `tradeTransfer`; every trade quote goes through `TradeDirector.quote(kind, good, rep, sectorKey)`.
- **Link teleporters** pair at run time through `findLinkTwin`, never by position; NPC-owned teleporters refuse pairing requests. Military bases' gates are owner + allies; patrol ids start `patrol-` (in `isDirectorBotId`). Lock: `transitHubs.test.ts`.
- Detail: [procedural-bases.md](../../docs/architecture/procedural-bases.md#server-implementation-notes), [economy-and-trade.md](../../docs/architecture/economy-and-trade.md#server-implementation-notes), [transit-hubs.md](../../docs/features/transit-hubs.md#server-implementation-notes), [military-bases.md](../../docs/features/military-bases.md#server-implementation-notes).

## Teleporters and alien gates

- **Pad holds** move only via `StorageService.padLoad` / `padUnload` / `padSwap` / `padSwapAcross` / `takePadForSpill` (one group each). Capacitor charge never discharges batteries.
- **Director bots** cross only via `TeleportBroker.moveBot` → `LivingWorldDirector.teleportBot`. Rooms register with the broker on create and unregister on dispose. Lock: `teleporter.test.ts`.
- **Pairing consent:** only the owner of the asked teleporter can accept a `teleport_pair_request` (`teleport_pair_answer` handler in `SectorRoom` checks `req.toOwner` and the target's owner). Lock: `teleporterAcross.test.ts`.
- **Alien gates** are unbuildable and invulnerable; pair a gate only through `findAlienTwin`, never a pre-computed uid. `evictSwarmEntity` must `forget` the ship; the disable runs through the shared `gateDisabledInput` (#15). Locks: `AlienGateGuard.test.ts`, `disableParity.test.ts`, `alienGates.test.ts`.
- Detail: [teleporters.md](../../docs/features/teleporters.md#server-implementation-notes), [alien-gates.md](../../docs/features/alien-gates.md#server-implementation-notes).

## Fire control: lock-to-fire is universal (root invariant #19)

- **Every player is tracked:** `LockSubsystem` from `onJoin` to leave (`LeaveHandler.forgetLocks`). Never reintroduce a pass-through ("legacy rules") for an untracked player.
- **Fire gate:** a group fires only with a LOCKED target, and only the mounts that pass the shared `mountFiresOn`: in the mount's own reach of the target's hit shape AND bearing per `mountBearsOn` (naval guns `TURRET_FIRE_MISS`, others `FC_MOUNT_FIRE_TOLERANCE`); none ⇒ `hit_ack { rejected }`, no cooldown or energy spent. Locks: `playerNavalFireTolerance.test.ts`, `playerTurretFireRange.test.ts`.
- **Turret aim:** player mounts aim only at their group's lock (locked, else acquiring), else home; capital per-turret picks use the shared `pickTurretLock` (#15). No player auto-target or manual-aim mount path.
- **Every self-chosen target ranks by `mountPriority`** (player AUTO, turret share-out, NPC and structure turrets; heavy guns: capitals and structures first). A holding NPC turret switches only to a strictly preferred class. Lock: `heavyGunsPreferBig.test.ts`.
- **Heavy guns lock small targets slowly, never impossibly, whoever flies the ship:** player and NPC take ONE `lockSeconds` path; never add a per-pilot flag (a pilot difference is a bug). Locks: `npcLockParity.test.ts`, `lockTime.test.ts`, `fireControlLocks.test.ts`.
- **`lock_track` is verified** with the shared `lockLineHolds`; a failing claim releases the lock. Lock: `LockSubsystem.test.ts` "lock_track is verified".
- **Tests use the triggers** (`instantLock`, `anyTarget`, `groupMode: 'manual'`, `_internals.forceLock`, room `lockTimeCapS`); never add a test-only fire bypass. Lock: `tests/integration/sectorRoom/lockTimeCap.test.ts`.
- **Locks work at any distance; only firing is range-limited:** no reach gate in `lockSeconds` / `lockLineScore` (both sides); an AUTO group drops its own pick once no mount reaches it (`LockSubsystem.inFireRange`) and re-picks; manual locks persist. Locks: `LockSubsystem.test.ts`, `lockTime.test.ts`.
- **Locks and attacks keep hostility alive, never create it:** a live player lock on an already-hostile NPC, and an NPC's own lock/hits on a pilot already in its ledger, re-stamp hostility; a lock refreshes only while the pilot is inside that NPC's fire range. Locks: `lockKeepsHostile.test.ts`, `npcStaysHostileWhileAttacking.test.ts`.
- **NPC drones and NPC capital turrets fire only with a completed lock on their own target** (capitals lock structures per turret). Locks: `NpcLockSubsystem.test.ts`, `capitalLockGate.test.ts`, `coastalDuel.test.ts`.
- **NPC and structure fire range is per mount, to the target's hull:** every turret range check goes through the shared `mountInReach` (via `mountCanEngage`, `AiFireResolver.bearingMask`, `pickTurretLock`); candidate searches widen with `mayBeInReach`. Never add a centre-distance reach gate. Lock: `npcTurretHullRange.test.ts`.
- **An AI shot leaves down its drawn barrel; only a barrel that bears fires.** `swarmEntitySnapshot` fills ONE shared scratch: copy what you need before any other lookup. Locks: `aiTurretFacesShot.test.ts` (unit + integration), client `aiTurretDrawnFollowsSnapshot.test.ts`.
- **Spectating doesn't dodge a fight:** NPC fire control engages a pilot via `engageablePilotHull`; a pilot capital is hit on its hull outline. Locks: `spectateStillTargeted.test.ts`, `capitalShieldHugsHull.test.ts`.
- **Not yet gated:** a drone shot at a non-pilot target that strays into a pilot.
- Detail (wiring, snapshot slices, per-mount ledgers): [fire-control.md](../../docs/architecture/fire-control.md#server-implementation-notes).

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

## Combat Architecture (Phase 4)

- **Lag-comp hit tests are pure geometry** (`rayHitsSphere` against `SnapshotRing`), never Rapier `castRay`: the main thread has no live Rapier world.
- **Stale fire claims are clamped** to `serverTick - LAG_COMP_WINDOW` (`clampFireTick`), never rejected.
- **Bolts and missiles step by worker ticks**, not room updates (capped catch-up). Lock: `ProjectilePipeline.workerTicks.test.ts`.
- **Adding a weapon never edits `SectorRoom.ts`**, only the catalogue; each projectile record carries its own damage, radius and lifetime.
- **Projectiles hit swarm entities through `ProjectileBroadphase`**, which must equal the full scan. Lock: `ProjectilePipeline.broadphase.test.ts`.
- **Every cleanup path (leave, transit, death, eviction) clears `playerMountAngles` and `droneMountAngles`** with `lastFireClientTick`, or they leak across reconnects.
- **Drones target active hulls only.** Lock: `tests/integration/sectorRoom/droneTargetActiveOnly.test.ts`.
- Detail: [sector-room-anatomy.md](../../docs/architecture/sector-room-anatomy.md#server-implementation-notes) (lag comp, backpressure, cooldown), [weapon-mounts.md](../../docs/architecture/weapon-mounts.md#server-implementation-notes) (multi-mount fire, mount rotation, snapshot `mountAngles`/`hp`).

## SectorRoom subsystems

- **State lives on the subsystems; integration tests reach private state only through `SectorRoom._internals`**, never local cast interfaces. Detail: [sector-room-anatomy.md](../../docs/architecture/sector-room-anatomy.md#subsystem-map), [`_internals`](../../docs/architecture/sector-room-anatomy.md#_internals-test-accessor).

## Threading

- **A new CPU-heavy subsystem defaults to a worker**, not the main thread. Physics runs on `PhysicsWorkerPool` (several sector worlds per worker); sqlite writes run on their own worker. Detail: [sector-room-anatomy.md](../../docs/architecture/sector-room-anatomy.md#threading).

## Testing patterns

- **Decision logic over state:** hand-rolled mocks (`src/server/transit/TransitOrchestrator.test.ts` is the model).
- **Anything on the snapshot wire or broadcast gates, and every new visible entity type:** an integration test on `tests/integration/sectorRoom/harness.ts` (`pnpm test:integration`).
- **A test that needs a live hull uses `harness.connectActive`** (sends `client_ready`); `connectAs` alone never activates. Detail: [DETERMINISM.md](../../tests/integration/sectorRoom/DETERMINISM.md#server-testing-patterns).

## Generic Entity Pipeline

- **A new damageable type is a leaf + a registry row**, never a new dispatch branch; `EntityResolver` owns the ordered selection. Golden master: `DamageRouter.dispatch.test.ts`.
- **`applyInteraction` stays ONE monomorphic function**; never a per-class `receiveInteraction()`. Locks: the guard comment + `benchmarks/damageDispatch.bench.ts`.
- **A new pose-core kind is a swarm-registry record**; seeding `swarmHealth` on spawn is its only damage line (absent = immune). Add its integration test.
- **Entity-sync sends go through `EntitySyncRouter.route`** (binary pose-core first, then the JSON slice); a byte change to either broadcaster needs the netgate. Lock: `EntitySyncRouter.test.ts`.
- Detail: [generic-entity-pipeline.md](../../docs/architecture/generic-entity-pipeline.md#server-implementation-notes).

## Structures: placement, power grid, shield fence

- **Placement checks structures AND asteroids** through the shared `canPlaceStructureAt` / `placementRejection`; `remove` is owner-gated. Locks: `placementRules.test.ts`, `StructurePlacementSubsystem.test.ts`, `structurePlacementValidation.test.ts`.
- **Grid changes touch the snapshot path** (`structures[]`, `grid_pulse`): `pnpm e2e:netgate` required. `StructureGridSubsystem.pulse()` is the directly-callable 1 Hz heartbeat, off the 60 Hz tick.
- **Shield-wall bodies live in `PhysicsWorld.wallBodies`**, never `this.bodies`. A pylon with any active wall takes no damage (`applyDamage` → `absorbForPylon`). Swarm shield regen covers `rec.kind === 1` only.
- Detail: [structures-and-power-grid.md](../../docs/architecture/structures-and-power-grid.md#server-implementation-notes).

## Abandon → scrap (no wrecks)

- **An abandoned hull (active or lingering) shatters to scrap and leaves the world**; no wreck entity exists. The lingering path is `shipInstanceId`-keyed and never touches a `playerId`-keyed map. Locks: `abandonToScrap.test.ts`, `abandonLingeringToScrap.test.ts`. Detail: [composite-ships-and-scrap.md](../../docs/architecture/composite-ships-and-scrap.md#server-implementation-notes).

## Same-sector instant pilot swap — `pilot_ship`

- **Reclaims only the requester's own lingering hull in this room** (anything else is a silent no-op), displaces any active hull first, and re-drives the unified join handshake: no second activation path (#12). Netgate required. Lock: `pilotInSectorShip.test.ts`. Detail: [spectator-and-construction-mode.md](../../docs/architecture/spectator-and-construction-mode.md#server-implementation-notes).

## Shield/Hull + ramming

- **Shield values reach clients on discrete events only** (`DamageEvent`, `ShieldEventMessage`); the regen ramp is never streamed.
- **Ram damage is rounded before the emit guard** (a sub-0.5 hit emits nothing); contact → damage is live-loop, so netgate. Lock: `ramming.test.ts`. `feel-test-lockstep.spec.ts` is host-load sensitive: confirm on a quiet host or CI.
- Detail: [shield-hull.md](../../docs/features/shield-hull.md#server-implementation-notes).

## Scrap-on-death

- **Every death path spawns scrap BEFORE the slot is freed**; a dying scrap piece never re-shatters. Scrap is transient (not persisted) and FIFO-capped; wire changes need the netgate. Locks: `ScrapSpawner.test.ts`, `scrapOnDeath.test.ts`, `lingeringScrapOnDeath.test.ts`. Detail: [composite-ships-and-scrap.md](../../docs/architecture/composite-ships-and-scrap.md#server-implementation-notes).

## Capital wrecks

- **Break-up ON by default** (`capitalWrecks` / `subcapWrecks`, owner 2026-11-14): a room opts out with `false`, env `EQX_*_WRECKS=0` forces it off (`wreckSwitchOn`); one death effect per ship (a breaking kind never sheds scrap). Hit tracking is pooled (#14). Test trigger: `test_kill_capitals`, room `wreck-test`.
- **Wreck pieces (kind 4) block every weapon:** a new weapon or hit path must handle kind 4 and pass its shot direction (knock-back). Locks: `wreckOverkillKnockback.test.ts`, `wreckRigidHold.test.ts`.
- **Snapshots carry wreck deltas only:** never the whole list, never vertices; every piece removal reaches `pieceGone`. Locks: `SnapshotBroadcaster.wreckDeltas.test.ts`, `wreckWireConvergence.test.ts`, `wreckLateJoiner.test.ts`.
- Detail: [capital-destruction.md](../../docs/architecture/capital-destruction.md#server-implementation-notes).

## Solar-system sectors

- **Place arrivals, convoys, elites and events by pocket**; with no pockets fall back to `HOME_POCKET_HALF_EXTENT`, never `SECTOR_PLAYABLE_HALF_EXTENT`. Detail: [solar-system-sectors.md](../../docs/architecture/solar-system-sectors.md#server-implementation-notes).

## Flagship fleets

- **Escort stations come from hull radii (`escortRing`)**, never a flock distance; `warpBot` lands at `landingPoint`; `flagship-` ids are never shed. Kill switch `EQX_DISABLE_FLAGSHIPS`. Detail: [capital-ships.md](../../docs/features/capital-ships.md#server-implementation-notes).
