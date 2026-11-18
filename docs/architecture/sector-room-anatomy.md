# SectorRoom Anatomy (post-hazy-pillow Step 14)

`src/server/rooms/SectorRoom.ts` was 4365 LOC at the start of the
`hazy-pillow` decomposition plan. After Steps 1–14 it is **4236 LOC**
with subsystem ownership for 10 distinct concerns. This document
captures the post-extraction shape so future contributors can find the
field cluster owning any piece of state they need to touch.

## Subsystem map

| Subsystem | File | Concern | Field cluster |
|---|---|---|---|
| `slots` | [`PlayerSlotMap.ts`](../../src/server/rooms/PlayerSlotMap.ts) | SAB slot allocation + bookkeeping | `playerToSlot`, `slotToPlayer`, `freeSlots`, `lingeringSlots`, `initialSpawnPositions` |
| `swarm` | [`SwarmLifecycleManager.ts`](../../src/server/rooms/SwarmLifecycleManager.ts) | Swarm entity registry + interest grid | `registry`, `grid`, `interestScratch` |
| `physics` | [`PhysicsBridge.ts`](../../src/server/rooms/PhysicsBridge.ts) | Worker IPC boundary | `worker` (handle), `sabAppliedTicks`, `post(cmd)` |
| `combat` | [`CombatSubsystem.ts`](../../src/server/rooms/CombatSubsystem.ts) | Fire / projectile / drone HP+shield state | `lastFireClientTick`, `liveProjectiles`, `projectileCounter`, `swarmHealth`, `swarmShield`, `swarmShieldLastDmg` |
| `mounts` | [`MountAimSubsystem.ts`](../../src/server/rooms/MountAimSubsystem.ts) | Per-mount turret rotation state | `playerMountAngles`, `playerSlotTargets`, `mountTargetsScratch`, `droneMountAngles`, `droneSlotTargets`, `droneMountTargetsScratch` |
| `ai` | [`AiSubsystem.ts`](../../src/server/rooms/AiSubsystem.ts) | Server-authoritative AI controller + per-tick view scratch | `controller` (AiController), `scratch` (AiPlayerView[]) |
| `snapshot` | [`SnapshotBroadcaster.ts`](../../src/server/rooms/SnapshotBroadcaster.ts) | Broadcast cadence + idle tracker + TiDi clock + boost/thrust sets | `encoder`, `broadcastCounter`, `lastInputCaches`, `idleTracker`, `forceBroadcastUntilTick`, `ticksSinceSnapshot`, `boostingPlayers`, `thrustingPlayers`, `lastSentClockRate`, `clock` (SimulationClock) |
| ownerless evict | [`OwnerlessShipEvictor.ts`](../../src/server/rooms/OwnerlessShipEvictor.ts) | Lingering-hull ownerless-evict timers (the former `WreckLifecycleCoordinator` was removed when wrecks were retired — P6.3/C3; abandon now → scrap) | `ownerlessShips` |
| `players` | [`PlayerSessionManager.ts`](../../src/server/rooms/PlayerSessionManager.ts) | Session bookkeeping + per-tick input counter | `sessionToPlayer`, `playerToSession`, `inputCountThisTick`, `playerToUser`, `playerToActiveShipInstance`, `playerToTransitInFlight` |
| `obstacles` | [`SectorObstacles.ts`](../../src/server/rooms/SectorObstacles.ts) | The one obstacle gatherer: placement / line-of-sight rocks, landing, join and convoy spawn clearance ([navigation](navigation.md#the-one-obstacle-gatherer-serverroomssectorobstaclests)) | pooled `rockList`, `boxes`, `circles`, `walls` |
| `nav` | [`RoomNav.ts`](../../src/server/nav/RoomNav.ts) | Cut field's nav maps in the nav worker, AI routes, player autopilot route requests ([navigation](navigation.md)) | `field`, `routes`, `autopilot` |
| `aiGrids` | [`AiNeighbourFill.ts`](../../src/server/rooms/AiNeighbourFill.ts) | AI neighbour + debris grids, one registry walk per tick | `neighbourGrid`, `wreckGrid`, A/B switches |
| `budget` | [`TickBudgetTelemetry.ts`](../../src/server/rooms/TickBudgetTelemetry.ts) | Per-tick timing + hitch detection + 60-sample emit | `sums`, `thisTickPhases`, `historyRing`, `sampleCount`, `maxTotalMs`, `overBudgetCount`, `lastHitchAtMs` |

The 10 subsystems own STATE today. The plan's R1 envisioned them
owning METHOD BODIES as well; in this pass we shipped storage
ownership and left the methods inline in SectorRoom because each
method body crosses multiple subsystems (e.g. `convertShipToWreck`
spans 8 of them per [Trap 6 of the plan](#trap-6-eight-collaborator-transactions)).
Subsequent commits can grow these classes as the orchestrations
mature.

## What stayed in SectorRoom

- The 9-phase `update()` body itself — `sabRead`, `projectiles`,
  `swarmEncode`, `swarmBroadcast`, `snapshotBroadcast`, `aiTick`,
  `aiFire`, `playerMounts`, `droneMounts`. Each `phaseTime(key)`
  callsite is now a 1-line delegator to `this.budget.mark(key)`. Phase
  body content (the actual work) remains inline.
- `onJoin` / `onLeave` lifecycle methods. `onJoin` has 5 branches plus
  one fall-through per [Trap 8](#trap-8-onjoin-branch-list); the body
  spans every subsystem above.
- `abandonShipToScrap` / `abandonLingeringHullToScrap` — the abandon
  transactions (an abandoned hull shatters into scrap + frees its slot;
  wrecks were retired P6.3/C3, so these replaced the old
  `convertShipToWreck`/`destroyWreck` + `WreckLifecycleCoordinator`).
- The worker `onmessage` dispatcher — a single inline switch that
  routes `READY`, `SLEEP_TRANSITION`, `CONTACT_BATCH` (per
  [Trap 4](#trap-4-no-multi-subscriber-fan-out)) to the right
  subsystems. Per the trap, the inline pattern is preserved
  deliberately — there is no multi-subscriber bus fan-out today.
- `spawnWorker()` itself — its body builds the worker bundle, attaches
  message handlers, and resolves the `READY` promise. Calls
  `this.physics.setWorker(...)` to wire the bridge.

## `_internals` test accessor

[`SectorRoomInternals`](../../src/server/rooms/SectorRoom.ts) is the
test-only piercing surface (Step 1 of the plan). Integration tests
reach into private state via `room._internals` rather than redefining
their own cast interfaces. Currently exposed:

- `serverTick` (getter)
- `aiPlayerScratch` (getter → `this.ai.scratch`)
- `ownerlessShips` (getter → `this.ownerlessShips`)
- `applyDamage(...)` (bound method on SectorRoom)
- `postToWorker(cmd)` (bound method on SectorRoom)

As subsystems extract method bodies, the `_internals` getters update
under the hood; test bodies stay stable. This is the surface that
made the post-Step-1 extractions safe — five integration tests
(`droneTargetActiveOnly`, `ramming`, `hitAckContract`, `lingering`,
`rosterFullWreck`) pierce through it.

## Identity preservation (Trap 2)

`TransitOrchestrator` reads `room.sabF32`, `room.playerToSlot`,
`room.playerToUser`, `room.playerToTransitInFlight`, and
`room.lastFireClientTick` as direct property accesses on the
`TransitHostRoom` adapter (`SectorRoom.asTransitHost()`). After the
hazy-pillow extractions these fields live on subsystems
(`this.slots.playerToSlot`, `this.players.playerToUser`, etc.), and
the adapter forwards them as the original property names. The
underlying objects are identity-preserved — TransitOrchestrator caches
references at construction time, so a getter that returned a fresh
wrapper would break those caches. The same identity-preservation
discipline applies to every Map field exposed as `public readonly` on
the subsystems.

## Trap 4: no multi-subscriber fan-out

The revised plan corrected a false claim from R1: today there is
**one** inline worker `onmessage` switch, not a multi-subscriber bus
fan-out. The only SectorRoom bus subscriber is `bus.on('SHIP_DESTROYED', ...)`
(line ~830). `noteSectorEvent` is called inline at the projectile-
in-flight / motion-above-epsilon check sites, NOT via a bus listener.
`COLLISION_RESOLVED` is emitted (worker handler) but never subscribed
to. The damage-on-collision path is inline in the worker handler.

When subsystem method bodies migrate in future commits, the inline
dispatcher pattern stays. Introducing a multi-subscriber fan-out is a
separate, reviewed design change.

## Trap 5: snapshots ship LAST tick's mount angles by design

`tickPlayerMounts` runs in the `playerMounts` phase, which is AFTER
`snapshotBroadcast`. Each snapshot ships the previous tick's angles by
design — the client renders with a snapshot delay anyway, and writing
angles after the broadcast lets prediction use this tick's input to
plan next tick's aim. Any future migration of `tickPlayerMounts` into
`MountAimSubsystem` MUST preserve this ordering.

## Trap 6: multi-collaborator transactions

> **Wrecks retired (P6.3/C3).** This trap originally described
> `convertShipToWreck` (an 8-collaborator transaction) + why
> `WreckLifecycleCoordinator` was its own subsystem. Wrecks are gone:
> abandon now produces SCRAP via `abandonShipToScrap` /
> `abandonLingeringHullToScrap` (inline on SectorRoom), which is the
> surviving multi-collaborator example. Note it spawns scrap + **DESPAWNs**
> the body (no wreck rekey) instead of re-keying a slot to a wreck.

`abandonShipToScrap` touches:

1. `spawnHullScrap` → `ScrapSpawner.spawnFromDeath` (composite hull → scrap)
2. `slots.freeSlots` push + worker `DESPAWN` post (PhysicsBridge)
3. `slots.playerToSlot` / `slots.slotToPlayer` (PlayerSlotMap)
4. `combat.lastFireClientTick` (CombatSubsystem)
5. `mounts.clearPlayer` (MountAimSubsystem)
6. `slots.initialSpawnPositions` (PlayerSlotMap)
7. `shipPoseCache` + `snapshotRing.unregisterEntity`
8. `state.ships` delete (schema)
9. `players.playerToActiveShipInstance` (PlayerSessionManager)
10. `client.leave(1000)` (Colyseus client lifecycle)
11. `players.playerToSession` / `sessionToPlayer` / `playerToUser`
    (PlayerSessionManager)

The lingering variant (`abandonLingeringHullToScrap`) is keyed by
`shipInstanceId` and touches ONLY the lingering bookkeeping
(`lingeringSlots` / `lingeringPoseCache` / `ownerlessShips`) — never a
playerId-keyed map, because the owner may be piloting a different active
hull.

## Trap 8: `onJoin` branch list

`onJoin` body has FIVE distinct branches plus one fall-through:

- **(a) Limbo rebind** — incoming `shipInstanceId` matches a Limbo
  entry; rebind to existing schema row.
- **(b) Lingering-hull rebind** — `shipInstanceId` matches an
  ownerless ship currently in `slots.lingeringSlots`; reclaim slot.
- **(c) Transit-arrival rebind / displace** —
  `players.playerToTransitInFlight` had the player; consume the
  arrival, rebind to the destination sector's reserved slot.
- **(d) Fresh spawn from roster shipId** — roster has a row for this
  player; spawn into a new slot with persisted hull / shield /
  inventory.
- **(e) Engineering-room synthetic-UUID fresh spawn** — gate:
  `bindRosterEntry === '' && sectorKey === null`. Synthesises
  `randomUUID()` for `ship.shipInstanceId`. **Has its own regression
  history** ([`rosterFullWreck.test.ts`](../../tests/integration/sectorRoom/rosterFullWreck.test.ts)
  locks the 2026-05-13 bug where this fired unconditionally).
- **(f) Stale-ownerless fall-through** — explicitly logged as
  `'stale ownerless entry — falling through to fresh spawn'`. Not a
  branch per se but a recovery path when (b) fails.

The order of side-effects within each branch (slot alloc → schema
write → worker SPAWN → bus emit → snapshot grace set → roster mirror)
must stay identical when `PlayerSessionManager.onJoin` eventually
absorbs the body.

## Deferred work

These items remain explicitly deferred from the hazy-pillow plan:

- **Step 7 (LagCompRing wrapper)**: `SnapshotRing` already lives in
  its own module; wrapping it would add an empty indirection.
- **Step 13 (RosterPersistenceAdapter)**: roster operations are
  method calls into the existing `PlayerShipStore` module — no
  roster-specific storage on SectorRoom to relocate under the
  storage-pattern this plan used.
- **Step 15 (SectorTransitAdapter)**: existing `asTransitHost()`
  method already implements the `TransitHostRoom` interface. Pulling
  it out of SectorRoom is cosmetic.
- **Step 16 (LivingWorldBridge)**: the 6 forwarder methods
  (`playerCount`, `hasFreeSlot`, `eventBus`, `spawnLivingWorldBot`,
  `despawnLivingWorldBot`, `markBotHostile`) are already thin
  delegators. Adding a class wrapper changes nothing the
  `LivingWorldDirector` sees.
- **Step 17 (`update()` collapse)**: would require extracting many
  method bodies that span multiple subsystems. Best done once the
  method-body extractions catch up to the storage-ownership work
  this plan shipped.
- **Method-body migrations** for Combat (handleFire, applyDamage,
  advanceProjectiles, etc.), MountAim (tickPlayer/tickDrone), AI
  (tick, drainFire), Snapshot (the per-client broadcast loop), and
  PlayerSession (onJoin / onLeave). The state ownership is in place;
  the methods migrate as their cross-subsystem interfaces stabilise.

## What was NOT broken

The hazy-pillow plan's 19 integration tests + 5 unit tests + dev
server boot all stay green at every commit. The
`_internals` accessor (Step 1) made the storage-ownership pattern
safe — every subsequent extraction either updated `_internals` getters
in-place or left them untouched because the tests don't pierce that
field.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### Combat Architecture (Phase 4) — lag comp, projectiles, backpressure

- **SnapshotRing** (`src/server/lagcomp/SnapshotRing.ts`): pre-allocated Float32Array ring buffer (1000 × 12 × 16 bytes = 192 KB). `record(tick, entities)` called every `update()`; `getAt(entityId, tick)` returns rewound position for lag-comp. No per-tick allocation.
- **Lag-comp hit resolution**: uses the pure-geometry `rayHitsSphere()` from `src/core/combat/Weapons.ts` against SnapshotRing positions — NOT Rapier's `castRay`. The server main thread does not have a live Rapier world (physics lives in the worker).
- **Projectile simulation**: Euler integration in `advanceProjectiles()` on the main thread, not in the physics worker. Lifetime limit: 180 ticks (3 s). Circle-circle collision detection per-tick against each live ship.
- **Bolts and missiles step by WORKER ticks, not room updates (2026-11-12):** under load the room loop can run slower than the physics worker (measured ~25 Hz vs ~34 Hz on the loaded E2E host, where every room shares one worker that was itself behind real time); a projectile or missile that moved one 1/60 s step per `update()` then slowed down relative to the ships (heat-seekers at ~150 u/s instead of 400 in the loaded E2E server). Each update now steps a bolt (`ProjectileRecord.lastTick`, one swept step of `n × v·dt`) or a missile (`MissileRecord.lastTick`, the per-tick guidance body run `n` times via `stepMissile`) by `n = max(1, ticks since its last step)`, capped at 30 for a hard stall (`MAX_CATCH_UP_TICKS` / `MISSILE_MAX_CATCH_UP_TICKS`). `max(1, …)` keeps a room that keeps pace exactly as before. Naval shells already follow the worker tick in closed form (shells as events). The general fix (every timer on game time) is the shelved time-scale plan (docs/architecture/game-time-scale.md). Lock: `ProjectilePipeline.workerTicks.test.ts`.
- **Backpressure** (`src/server/net/Backpressure.ts`): `checkBackpressure(client, logger)` returns `'ok' | 'drop' | 'close'`. Called in the per-client broadcast loop in `update()`.
- **Weapon cooldown enforcement**: `lastFireTick` map, compared against `WEAPON_COOLDOWN_TICKS = 10` (167 ms at 60 Hz). Excess fire requests return `hit: false` immediately.
- **Temporal plausibility**: fire claims with `tick < serverTick - LAG_COMP_WINDOW` are **clamped** to `serverTick - LAG_COMP_WINDOW` (via `clampFireTick`) and lag-comp-resolved against the oldest ring pose — they are NOT rejected. Future claims (`tick >= serverTick - LAG_COMP_WINDOW`, incl. client running ahead) pass through unchanged (`getPoseAt(future)` → live-pose fallback). The old hard-reject silently dropped legitimate post-stall fires; the clamp keeps the rewind bounded identically so there is no abuse vector.
- **Weapon catalogue (data-driven)**: `handleFire()` resolves `weaponDef = getWeapon(weaponId)` from `src/core/combat/WeaponCatalogue.ts` and branches on `weaponDef.mode`. Hitscan reads `range`/`damage` from the def; projectile passes `damage`, `radius`, `maxTicks`, `weaponId` into `spawnServerProjectile`. Each `ProjectileRecord` carries its own `damage`/`radius`/`maxTicks` — `advanceProjectiles()` reads them off the record, never off a global constant. **Adding a new weapon never requires editing `SectorRoom.ts`** — only the catalogue.
- **Projectile vs swarm collision**: `advanceProjectiles()` runs two collision passes per projectile per tick — first against player ships (lag-comp via SnapshotRing — currently the spawn tick's SAB pose for projectiles), then against swarm entities via `swarmRegistry.all()` reading current SAB pose. The swarm pass is required: solo play has only drones/asteroids as targets, so a missing swarm loop = "lasers sail through everything." Hit position (`hitX`, `hitY`) is threaded into `applyDamage()` and broadcast in `DamageEvent` for the client damage-numbers/health-bars pipeline. **Broadphase (ranges plan risk 2):** the swarm pass no longer scans every entity per shell. `ProjectileBroadphase` (`rooms/ProjectileBroadphase.ts`, 512 u hashed cells, flat typed arrays, alloc-free) bins every entity once per tick by a conservative box around its circle / footprint / gate parts, at a SAB pose copied at build (the narrow phase uses that copy); each shell queries its step's box and tests the candidates in registry order, so the first-contact winner and its tie-break equal the full scan's. It rebuilds mid-tick when `SwarmEntityRegistry.version` changes (a kill evicting or spawning entities). `broadphase: false` is the full-scan oracle. Locks: `ProjectilePipeline.broadphase.test.ts` (fast-check parity vs the full scan + the COUNT gate `PROJECTILE_NARROW_CHECKS_BUDGET` in `perfBudgets.ts`: 500 shells × 1,000 entities = 63 narrow checks/tick vs 500,000).

### Threading

- Phase 2 evicts Rapier to a `worker_threads` worker; the main Colyseus thread reads SAB directly.
- **Physics runs on a POOL of workers, several sector worlds per worker (memory, 2026-11-07).** A worker costs ~37 MB before it holds a body (a V8 isolate, the bundled code, the ship catalogue built at load), and one worker per sector held ~800 MB of worker heap for the 21-sector galaxy with nobody connected. `PhysicsWorkerPool` (`rooms/PhysicsWorkerPool.ts`) bundles the worker once, starts up to `EQX_PHYSICS_WORKERS` workers (default one per core minus one, max 4; `per-room` = the old one-per-sector, for A/B) and puts each room's world on the least-loaded one. `PhysicsWorkerProxy` is now a handle onto that world: `postCommand` tags the command with its `worldId` IN PLACE (no copy, #14) and `terminate` detaches the world (the worker stays). Each world keeps its own SAB, tick counter and Rapier world, so a room sees what it saw with a dedicated worker. Idle dev server: 1,966 MB → 908 MB rss; 21 sectors share 4 workers at 60 Hz. Diagnose with `GET /dev/memory` (rss, heaps, per-worker heap, which room is on which worker). Lock: `rooms/PhysicsWorkerPool.test.ts` (two worlds on one real worker, no crosstalk, detach stops one).
- **`EQX_GALAXY_SECTORS`** picks which galaxy sectors boot eagerly: unset = all, `none`, or a comma list (`rooms/galaxyBoot.ts`). A sector left out still starts when someone joins it. The showcase `lean` and `capitals` profiles boot none (they only use test rooms): such a server starts at ~270 MB.
- Phase 7 (shipped) moves `node:sqlite` writes to a dedicated `worker_threads` worker via the same `bundleWorker` esbuild helper used by the physics worker. The main thread holds only a **read-only** `DatabaseSync` for auth `SELECT`s.
- If you are adding a new CPU-heavy subsystem, default to spawning a worker rather than running on the main thread.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Phase 6a foundation — shipInstanceId on the wire + isActive flag (2026-05-13)**: `WelcomeMessage.shipInstanceId` (already shipped in Phase 5) and `SnapshotMessage.states[shipInstanceId]` (new — keyed by shipInstanceId, each entry carries `playerId` + `isActive`) form the wire-level identity for "which hull is this". The Colyseus `SectorState.ships` MapSchema **stays keyed by playerId in 6a** (Option A) — the one-active-hull-per-player invariant still holds, so the ~25 internal `state.ships.get(playerId)` callsites don't need a mechanical rekey yet. Phase 6b flips the schema key when lingering hulls actually require >1 entry per player. `playerToActiveShipInstance: Map<playerId, shipInstanceId>` is the indirection map populated on spawn and cleared on leave/eviction/wreck-conversion; `resolveActiveShipKey(playerId)` is the canonical lookup helper. Engineering rooms (`sectorKey === null`) generate a synthetic `randomUUID()` for `ship.shipInstanceId` at join time so the wire key + downstream lookups are never empty. `ShipState.isActive` is always true in 6a; Phase 6b sets it false for lingering hulls so the client's snapshot translator can gate visibility. Client side (C-ii strategy): `ColyseusClient.handleSnapshot` translates the shipInstanceId-keyed wire format to a playerId-keyed local view at ingest, skipping `isActive=false` entries. Internal mirror / predWorld / reconciler keys remain playerId so no render-code change is needed. Tests: `SectorRoom.shipKey.test.ts` locks the helper; `messages.test.ts` "Phase 6a wire shape" describe locks the wire contract.

### Server rules in full (moved from src/server/CLAUDE.md)

The zone `CLAUDE.md` keeps a condensed form of these rules; this is the full wording with its lock tests.

#### Combat Architecture (Phase 4)

- **Lag-comp hit tests are pure geometry** (`rayHitsSphere` against `SnapshotRing`), never Rapier `castRay`: the main thread has no live Rapier world.
- **Stale fire claims are clamped** to `serverTick - LAG_COMP_WINDOW` (`clampFireTick`), never rejected.
- **Bolts and missiles step by worker ticks**, not room updates (capped catch-up). Lock: `ProjectilePipeline.workerTicks.test.ts`.
- **Adding a weapon never edits `SectorRoom.ts`**, only the catalogue; each projectile record carries its own damage, radius and lifetime.
- **Projectiles hit swarm entities through `ProjectileBroadphase`**, which must equal the full scan. Lock: `ProjectilePipeline.broadphase.test.ts`.
- **Every cleanup path (leave, transit, death, eviction) clears `playerMountAngles` and `droneMountAngles`** with `lastFireClientTick`, or they leak across reconnects.
- **Drones target active hulls only.** Lock: `tests/integration/sectorRoom/droneTargetActiveOnly.test.ts`.
- Detail: [sector-room-anatomy.md](../../docs/architecture/sector-room-anatomy.md#server-implementation-notes) (lag comp, backpressure, cooldown), [weapon-mounts.md](../../docs/architecture/weapon-mounts.md#server-implementation-notes) (multi-mount fire, mount rotation, snapshot `mountAngles`/`hp`).

