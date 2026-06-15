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
