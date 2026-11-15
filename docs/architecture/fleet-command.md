# Fleet command (the RTS command layer): internals

The player-facing story is [docs/features/rts-command.md](../features/rts-command.md).
This page is how it is built: which pieces own what, and why each boundary is
where it is. The zone CLAUDE.md files carry the rules in short
(`src/server/CLAUDE.md` "Fleet command (RTS)", `src/client/CLAUDE.md`
"RTS command view", `src/core/CLAUDE.md` "AI pilots use a player's controls
only"); §7 keeps their full pre-diet text.

## 0. RTS Part B: the AI pilot brain flies owned hulls (in progress)

Part B replaces the wingman brain with the shared AI pilot brain, slice by
slice (plan `rts-one-ai-one-ship.md`, "Part B v2"). As of slice 2 an owned
hull is FLOWN by `HostileDroneBehaviour` (players side, [ai-pilots](ai-pilots.md)
"Player-owned ships"); `WingmanBehaviour` still exists, never ticked, only as
the store of mode / stance / order / squad state for the commands, the
status stream and persistence (deleted in slice 12). Where §1–§2 below
describe the wingman brain flying, read this section instead.

- **Attach / detach** (`SectorRoom.attachWingman` / `detachWingman`, under
  the same `EQX_DISABLE_WINGMEN` kill switch): the room registers the hull in
  `AiController` with `new HostileDroneBehaviour(pilotKindFor(kind,
  statAlloc), { side: 'players', ownerId, energyPool: <the ShipState> })`
  and the `{ hull: true }` registration flag, and unregisters it at every
  exit. `pilotKindFor` (`FleetCommandSubsystem.ts`) folds the ship's
  upgrades into the kind exactly as `applyShipInput` applies them (thrust,
  speed cap, turn) plus `effectiveShipEnergyMax`; `wingmanConfigFor` reads
  the same numbers from it.
- **Holds where it was parked:** attach sets the brain's move target and
  guard post at the hull's spot (`holdHullAt`); an idle brain with neither
  orbits the world origin (`tickPatrol`).
- **Guard leash (slice 5):** Stop (`orderIssued`: guard where the hull is),
  Move (guard the destination) and `set_mode` Defend (the `modeSet` hook:
  the wingman store's resolved post, else the hull's spot) all go through
  `holdHullAt`, so the brain engages only inside its guard radius round the
  post and returns there when idle ([ai-pilots](ai-pilots.md) "Capital
  broadside and guard posts"). Hunt lifts the leash in slice 6. Lock:
  `tests/integration/sectorRoom/ownedShipsGuardLeash.test.ts`.
- **Self pose:** `swarmEntitySnapshot` falls back to `lingeringPoseCache`
  (`lingeringHullSnapshot`, same shared scratch), so `runEntity` ticks a hull.
- **Keys:** the AI input sink's ONE hull branch (`postInput(slot, bits,
  hullId)`, `hullId` set only for a hull registration) posts the keys as the
  hull's pilot `INPUT` (`postHullInput`), never `AI_INPUTS`: the flame flags
  show and a reclaim's INPUT replaces them (`aiInputHeld` is only cleared by
  `DESPAWN` / `AI_INTENT`, so `AI_INPUTS` on a hull would outlive a take-back).
  Posted only when the keys change; the worker holds the last INPUT.
- **Energy: one owner.** The brain regenerates the hull's pool and pays its
  boost every tick it is ticked; `tickEnergy` no longer regenerates parked
  hulls and a hull never joins `boostingPlayers`. Guns still pay from the same
  pool through `PlayerFireResolver.fireHull`.
- **Enemies:** `fillSwarmTargets` fills whenever an owned hull is attached
  (not only in a mixed-allegiance sector), so a hull sees on-sight foes
  (robots).
- **Fire:** `tickWingmanTargets` points the hull's `wingmanLocks` at the
<<<<<<< HEAD
  brain's `getTargetId()` (none under hold fire) → `tickHull` →
  `fireHull`. The registration flag keeps the brain's `intent.fire` out of
  `handleAiFire` / `AiFireResolver`. Slice 3 moves the trigger to
  `intent.fire` (with the line-of-fire gate).
- **Retaliation (slice 4):** `applyDamage` on an attached hull calls
  `ownedHullRetaliates` (BEFORE the hit, so a killing blow still turns its
  squad): `aiController.markHostile(hull, hostileActorOf(shooter))` for the
  hull and each AI-flown member of its squad with the same owner; the
  owner's own fire (their playerId or another of their hulls) is skipped.
  After the hit, `noteOwnedHullDamage` → `aiController.noteDamage` with the
  hull lost (shield-only hits note nothing; owned ships roll but always fight
  on). The fleet's `noteDamage` / `recentAttackerOf` ledger is gone.
  Lock: `ownedShipsRetaliate.test.ts`, `wingmanFights.test.ts` "defensive",
  `wingmanFightsRobots.test.ts` "shield hits alone".
=======
  brain's `getTargetId()` (none under hold fire). The trigger is the brain's
  `intent.fire` (slice 3): for a `{ hull: true }` registration
  `AiController` hands it to the sink's ONE hull fire branch
  (`postHullFire(hullId, targetId)` → `hullTrigger`, never `handleAiFire` /
  `AiFireResolver`), and `tickWingmanFire` (same tick, after the AI tick)
  pulls `fireHull` on each locked group only while the trigger is held at the
  target the locks follow. So the hull fires only when its pilot would: aim
  tolerance (the hull cone for fixed guns), range and the charge wind-up room.
  A turret-fire-control hull (a capital) has no brain trigger (its brain never
  fires; the turrets do as each bears, as for an AI capital), so its trigger
  is its lock. Each barrel then passes the AI pilots' one `LineOfFireGate`
  (`hullLineBlocked`; [allegiances](allegiances.md) "Line of fire"): a
  player's ship, the owner's structures or a wreck piece on the line holds it,
  and the brain hears the blocker (`noteBlocked`). Charges: the player
  pipeline has no wind-up, so a hull never writes the one charge store
  (`WeaponMountTicker.charges`); `isCharging` reads false for it and nothing
  there needs re-keying in `shipKeyMoved`. Locks:
  `tests/integration/sectorRoom/ownedShipTrigger.test.ts`,
  `AiController.input.test.ts`, `LineOfFireGate.test.ts`.
>>>>>>> 5938efe5 (Owned ships fire on their AI pilot's trigger (RTS Part B slice 3))
- **Orders:** the facade's `orderIssued` hook forwards each ship's own order:
  `move` → hold at the point, `stop` → hold where it is. Attack, modes,
  stance (except hold fire) and squads reach the brain in later slices.
- **Cost:** a hull brain decides every tick (60 Hz) like any AI pilot; the
  wingman re-planned at 10 Hz. The `rts-fleet` scene's
  `wingmanReplansPerTick` now counts hull brain decisions.
- Lock: `tests/integration/sectorRoom/ownedShipsAiPilot.test.ts`.

## 1. A parked ship is a lingering hull with a wingman brain

There is no new entity type. A ship you are not flying is the existing
**LINGERING** hull (the third liveness class of root invariant #17, beside
ACTIVE and DEAD): the body that Spectate / Command, a pilot swap, a fresh-ship
join, a snapshot restore or a cross-sector hand-off leaves in `lingeringSlots`.
Lingering hulls already collide, take damage, persist and render for everyone;
the RTS layer only gives each one a pilot.

That pilot is `WingmanBehaviour` (`src/core/ai/WingmanBehaviour.ts`), a pure,
zone-blind, allocation-free brain:

- **Mode** (`defend`, `patrol`, `escort`, `hunt`, `retreat`): what it does with
  no order.
- **Order** (`move`, `stop`, `attack`): a one-off on top of the mode; when it
  completes the mode resumes from where the ship is now. `stop` brakes in
  place (no steering) to below `brakeBand` and holds where it halts; a `move`
  of several ships to one point gives each its own spot in a hex cluster
  `flockSeparation` apart (`FleetCommandSubsystem.spreadMove`), so they never
  pile onto one point and shove (RTS stop drift, 2026-11-14).
- **Stance** (`aggressive`, `defensive`, `holdFire`): read by the server's fire
  target pick; in the brain it only stops a hold-fire hunter from chasing.
- **Formation role** (squads): hold a `formation.ts` slot round the leader.
- **Morale:** `reportDamage` → `MoraleTracker` → a seeded die (`rollMorale`);
  fall back or flee, then resume.

### The owner rule: player controls only

The brain outputs **player control bits** (`WingmanControls`: thrust, reverse,
turn, boost), never an impulse or an AI intent. `wingman/intentToControlBits.ts`
is the one adapter from desired velocity to keys. So a wingman-flown fighter has
exactly the speed, turn rate and energy of the same fighter flown by hand
(upgrades included): it flies through `applyShipInput`, the seam every pilot
uses. Boost goes through the hull's own energy gate (`canBoost`), re-checked
every tick while held.

## 2. FleetCommandSubsystem (server)

`src/server/fleet/FleetCommandSubsystem.ts` holds one brain per AI-flown owned
ship, keyed by `shipInstanceId`, over injected hooks (`ownerOf`, `readPose`,
`postInput`, `canBoost`, `resolvePoseInto`, `pilotShipOf`, `nearestHostile`).
It never touches the room directly, which keeps it unit-testable against a real
`PhysicsWorld`.

- **Attach / detach at every lingering entry and exit.** `SectorRoom` calls
  `attachWingman(id)` next to every `lingeringSlots.set` and `detachWingman(id)`
  next to every `.delete`. Detach posts neutral controls so a queued wingman
  input can't become the reclaimed hull's held input.
- **Owner-checked per id.** Every command names ship ids; each is checked
  through `ownerOf`, and foreign or unknown ids drop silently. A selection that
  includes the caller's own ACTIVE ship (named by playerId) drops that id: the
  pilot flies it.
- **Re-plan at ~10 Hz** (`FLEET_REPLAN_EVERY_TICKS` = 6, staggered by attach
  order). Between re-plans the physics worker holds the last INPUT (input queue
  rule #3 in `src/core/CLAUDE.md`), exactly as for a human whose keys are held.
  The wingman's INPUT goes to the hull's slot at `inputTick = serverTick`.
- **Squads** are 2–24 ships. A command that covers every AI-flown member is
  squad-wide (an order goes to the leader, a mode becomes the squad's mode); a
  subset command peels those ships off. If the owner flies a member, that ship
  leads (pilot-led squad) and the others form up on it.

### Fire goes through PlayerFireResolver

A parked hull is a player's ship, so it has a pilot's powers and no more. It
does not use `AiFireResolver`. A separate `LockSubsystem` instance
(`wingmanLocks`, keyed by shipInstanceId, groups in MAN) gives it locks;
`WeaponMountTicker.tickHull` aims its mounts with the pilot's rule;
`PlayerFireResolver.fireHull` fires with the full lock-to-fire gate (#19),
mount bearing, cooldown, energy and damage upgrades. The target (~10 Hz,
`tickWingmanTargets`) is the AI pilot brain's own (`getTargetId()`, none under
hold fire; §0; the old stance picker `wingmanFireTarget.ts` is gone). A hit from
a hull counts as its owner's hostile act (standing, faction escalation, NPC
base reactions), so commanding a fleet is never a way to dodge consequences.

## 3. Messages

Client → server (strict zod schemas, `malformed.record` on failure,
rate-limited per session per tick by `fleetMsgAllowed`):

| Message | Use |
|---|---|
| `command` | Leave the ship you fly (alias of `spectate`: it parks and gets a wingman). |
| `pilot_ship { shipId }` | Take a parked ship's controls (same-sector instant swap). |
| `fleet_order { shipIds, kind, x?, y?, targetId? }` | `move` / `stop` / `attack`. |
| `set_mode { shipIds, mode, x?, y?, route?, escortId? }` | Mode, with the picked route / escort / retreat point. |
| `set_stance`, `form_squad`, `disband_squad` | As named. |

A join can carry `startMode: 'command' | 'fly'` (galaxy rooms only; absent is
`fly`). `command` parks the hull at the arrival flip and sends
`control_mode { mode: 'command' }`, so the client lands in Command view through
the normal ship handshake.

### Why `fleet_status` is a message, not a snapshot field (invariant #16)

Root invariant #16 says client-visible state must be reconstructible from the
snapshot and join payload, and that a discrete event must never be the only
carrier. `fleet_status` looks like it breaks that, and it does not:

- The snapshot goes to **everyone** in interest. A wingman's mode, orders,
  patrol route, squad and morale are **private** to its owner; putting them on
  the snapshot would leak another player's plans.
- So `FleetStatusStream` (`src/server/fleet/FleetStatusStream.ts`) sends each
  session **only its own ships**, as compact tuples, every other fire of the
  selection-stats timer (~2.5 Hz), off the physics tick.
- Every send is the **whole** owned list and the client **replaces** its copy.
  It is a state stream, not an event: a dropped message is healed by the next
  one, and a late joiner converges within one period. Only a repeat empty send
  is skipped.

Everyone still sees the ships themselves (pose, hull, thrust, boost and mount
angles) on the normal snapshot and binary channels; only the orders are private.

## 4. Client

### Command view and the pointer router

Command view is `pilotMode === 'spectator'` (the stored field keeps its name;
the player-facing `ControlMode` is the selector `selectControlMode`, never
stored twice). While it is on, both pointer paths (main-thread
`PixiRenderer` and the worker) go through the pure `CommandPointerRouter`
(`render/input/commandPointerRouter.ts`):

- left tap → select (own ship) or inspect; left drag → selection box;
- right click → order (attack an attackable entity under the cursor, else move);
- middle button, wheel and hover → camera;
- touch: moving before `HOLD_THRESHOLD_MS` (500 ms) pans; holding still past it
  arms a box (FleetOverlay draws the growing ring); a tap with a selection is an
  order per the `fleetOrderMode` toggle (`render/input/tapAction.ts`).

### Selection, overlay and feedback sequence numbers

There is **one** selection (RTS Part A, owner decision 2026-11-14). The
renderer owns it, because only it can hit-test ships where they are drawn, and
it may be in a worker: the selected ships (`_selShips`, pure helpers in
`render/fleetSelection.ts`) and the focus (`_focusId/_focusKind`), the entity
whose details panel (`EntityStatsPanel`) shows, i.e. the one you clicked. With
ships selected the focus is one of them or none (`focusSurvives`); with none it
can be anything you tapped (a drone, a structure, someone else's ship). Every
selected ship and the focus get the same marker, `SelectionBracket`'s corner
brackets (screen space, one Graphics, drawn in the ticker after the camera
tick, never smaller than 14 px). Zustand holds it as one shape,
`selection: { ids, focusId, focusKind }`; the server `select_entity` stats
stream follows the focus. Before Part A there were two: an inspect selection
(bracket) and a fleet selection (green rings), which the owner found
confusing. Results reach the main thread through
`RendererFeedback`, as **monotonic sequence numbers** plus payload, never
one-shot booleans (a feedback frame can be read by several RAFs):

| Feedback | Main-thread consumer (`gameRafLoop`) |
|---|---|
| `fleetSelSeq` / `fleetSelIds` + `selectedPickId/Kind` | Mirror the ships and the focus into Zustand `selection` in one `setSelection` write (ids only, #2); a focus change starts / stops the `select_entity` stream. |
| `orderSeq` / `orderKind` / `orderX/Y` / `orderTargetId` | Send each new order once (`sendFleetOrder`). |
| `fleetPickSeq` / `fleetPickResult` / `fleetPickPoints` | Send the picked patrol / escort / retreat via `setMode`. |
| `takeControlsSeq` / `takeControlsId` | Double-click on an own parked ship → `takeControls`. |

The other direction goes through `IRenderer` methods, each a worker protocol
message: `setFleetOrderMode`, `setFleetPick` / `commitFleetPick`, and
`setFleetOverlayModel`. The overlay model is a compact per-ship list (squad,
order, destination, target, escort, route) built by
`fleet/fleetOverlayModel.ts` from the status, posted only when the status
version moves; the renderer can't read `fleet/fleetStatus.ts` because it may be
in another thread.

`render/FleetOverlay.ts` is **one** screen-space `Graphics` (it draws no ship
marker; that is `SelectionBracket`): drag box, order flash, hold cue, order lines (capped at `MAX_ORDER_SEGMENTS`),
patrol pick loop. One draw call, nothing per ship (the fleet-fight scene sits
near the draw-call budget).

### Status and the panel

`fleet/fleetStatus.ts` is a module singleton with a version counter, written
only by the `fleet_status` handler (`fleet/fleetStatusIngest.ts`: zod parse,
decode tuples, replace). `FleetPanel` (desktop) and `FleetStrip` (phone) poll it
at ~3 Hz, like the selection stats; nothing about it is in Zustand.

Hull % is not in the status: every ship's room-state `ShipState.health` /
`maxHealth` is already synced to every client, so `syncMirror` copies them onto
the mirror ship entries (`net/shipSchemaHealth.ts`) and the panel reads hull
from there (polled at the same cadence, so a hull hit shows without a status
change). Morale is not reported (a "Retreating" row says hull % or "shields
down"). The `fleet_status` tuple is append-only, so its hull (5) and morale (6)
slots stay, sent as `null` / `-1` and ignored; they still accept an older
sender's numbers. Shield % stays in the status for now: there is no per-ship
shield carrier for parked hulls. Commands go
through `fleet/fleetCommands.ts`, whose network senders are plugged in at boot
by `fleet/installFleetCommandSenders.ts`.

### Parked hulls on screen

A wingman-flown hull is a remote moving ship (root invariant #12): its
prediction body is reset from each snapshot WITH the snapshot's angular
velocity and forward-predicted with the wingman's last input bits
(`LingeringPredBodyManager`), and its exhaust and boost flame come from those
bits.

### Taking and letting go of the controls without a flicker

A ship's mirror key changes when someone takes its controls (its
shipInstanceId becomes the pilot's playerId) or lets go of them (back again).
The renderer keys every per-ship object by mirror key, so a dropped-and-recreated
entry used to rebuild the ship: a new sprite, art handle and turret cluster, a
fresh health bar, a shield "break" under the old key, reset engine ribbons.

Now a key change is one operation, `ColyseusClient.rekeyShip(from, to)`:

- the SAME entry object moves (pose, kind, turret angles, level, shield state);
- remote to remote: the body is respawned under the new key at its own state,
  with its render offset, inputs, lookahead and history;
- remote to local (take controls, at the welcome): the remote body goes first,
  then `tryInitPredWorld` spawns the local body at the entry's drawn pose;
- local to remote (Command / Spectate): the local body becomes a remote body at
  its own predicted state; `shipMirrorKey` keys the still-ACTIVE wire entry by
  shipInstanceId until the server parks it, so nothing evicts it;
- the pair is queued on `mirror.pendingShipRekeys` (a one-frame trigger cleared
  by `consumeOneFrameTriggers`, so it crosses the worker boundary with the
  mirror), and `PixiRenderer.rekeyShip` moves the sprite, art handle, turret
  cluster, health bar, label, exhaust (FxEngines), shield view (FxShields) and
  selection before the sprite pass. Far-zoom icons and the legacy particle /
  ring effects re-register by id on their own.

Another pilot's swap is found by the snapshot router and `syncMirror` through
`net/shipRekey.ts` `findRekeySource` (entries carry `shipInstanceId`). The
server keeps a reclaimed hull in every other player's snapshots while it joins
(`PendingJoinRecord.inWorld`); before, it vanished for the handshake and came
back as a new ship. The take-controls camera glide ends on the live follow
target, so follow takes over without a jump.

Still rebuilt: the radar icon (its category changes anyway). A reconnect onto a
lingering hull (`onJoin` rebind) still hides the hull from others while it joins.

## 4b. Fleet warp

In Command view, "Warp here" warps the SELECTED ships together and the
commander's view follows them (plan `rts-fleet-warp`). It is a branch of the
existing `TransitOrchestrator`, not a fleet order: `FleetCommandSubsystem` is
in-sector and never touches another room.

- **Wire.** `engage_transit` carries optional `shipIds` (1–64 ids, each 1–64
  chars), mutually exclusive with `shipId`. A group with no valid ship answers
  DOCKED `no_ships`. Client: `transitClient.engageTransit(room, key, arrival?,
  shipId?, shipIds?)`.
- **One record per group.** The in-flight map holds pilot warps under the
  playerId and fleet warps under `fleet:<commander>:<n>`, so several fleet
  warps run at once; a ship is in at most one (`hullToGroup`). Same
  `TransitStateMachine`, timer, `transit_state` (to the commander) and incoming
  banner ("N × ships", count rides `registerIncomingPlayer`).
- **No live hull needed.** The commander usually has no ship (Command view), so
  the branch skips `hasLiveHull` and the `playerToSlot` early stop. Each id is
  checked through `canFleetWarp` (a LINGERING hull in this room's
  `lingeringSlots`, alive, owned by the commander); others drop silently.
- **Hold.** Spooling ships get the existing fleet `stop` order and stay
  damageable; a cancel clears the order so each ship goes back to its mode.
  The commander's `cancel_transit` cancels their fleet warps too; a disconnect
  does not (the ships still go).
- **Drops.** `SectorRoom.detachWingman` → `dropHull` is the only drop point
  (ignored while the group's own commit runs). An emptied group cancels
  (`destroyed`). A new order / mode / stance to a spooling ship takes it out
  (`fleetCommandIssued`; a mode or stance also lets go of its hold).
- **Taking the controls of a spooling ship** keeps it in the group: the reclaim
  calls `noteTakeControls` first, so its detach marks it `pilotedId` instead of
  dropping it. At the jump that ship travels by the PILOT path (the
  commander's own seat with `shipId`, roster `markStored`, `warp_out`), the
  others as hulls, in the same commit. A commander flying a ship OUTSIDE the
  group stays with it (only the hulls go).
- **Commit order.** Seat first, hulls second: `issueTransitIdentity` +
  `reserveByName` (pilot seat when they fly a member, else `spectator: true`
  with `spawnX/spawnY` = the arrival anchor: the picked point, clamped, else a
  hull's pose), then `handOffHulls(ids, dest, anchor)`. No client ⇒ no seat,
  the hulls still go. A failed seat aborts the jump (`destination_unavailable`)
  and releases the ships. Hulls the hand-off did not move are released.
- **The hull hand-off (S3).** `handOffHulls` and the teleporter's
  cross-sector branch (`dispatchRiders`) share ONE helper,
  `SectorRoom.handOffHullsTo(toRoom, moves, arrival)`. Per hull: the far room's
  `canReceiveHull(id)` (a free physics slot, id not already there) is asked
  BEFORE anything changes here, so a hull that can't fit stays put (and is
  released); then `fleet.exportShip(id)`, `removeLingeringHullQuietly`,
  roster `markStored` to the far sector, the far room's
  `receiveLingeringHull(row)` and a `sector_change` audit (`entityKind:
  'hull'`, teleporter included). Squads with a member that moved are re-formed
  there from the moved members (`receiveFleetSquads` → `restoreSquads`, squad
  mode dropped). The far room is found with `TeleportBroker.room()`. Each hull
  stays LINGERING at both ends (#17); in the destination it is built by the
  same restore path a hydrate uses, so it is hit and targeted like any other
  parked hull there.
- **Arrival poses.** The pure `fleetArrivalPoses(hulls, anchor, out)`
  (`transit/fleetArrivalPoses.ts`): the LARGEST hull (by `hullExtent`) lands
  on the anchor, the others keep their offsets from it, each clamped to the
  bounds. `fleetAnchor` returns the largest hull's pose; the showcase cue
  `test_fleet_warp` uses the same function. Velocity is zeroed, heading kept.
  The destination nudges each `warp` arrival clear with `landingPoint(…,
  onlySkipShipId)`: unlike a pilot's landing, the owner's own ships and hulls
  ARE obstacles (only the ship being placed is skipped), so a fleet never lands
  on its own parked hull; the roster pose follows the nudge. A `teleport`
  arrival keeps its exact place on the pad.
- **Brains (owner rule, teleporter too).** On arrival the AI pilot GUARDS WHERE
  IT LANDS (`defend` at the landing point); stance and squad carry; an old
  route / post / escort belonged to the old sector and is dropped.
- **Crash duplicates.** `restoreLingeringHullsFromSnapshot` skips a row whose
  roster `lastSectorKey` is another sector (the hand-off re-homed it).
- **No destination capacity check** (owner: time dilation handles a crowd).
  The physics slot pool is a separate limit: see below.
- **Visuals (S4).** While a group spools, each parked hull's snapshot entry
  carries `warp: 1` (the existing `transitSpooling` dep, keyed by
  shipInstanceId); just after the hand-off the destination sends `warp: 3`
  from the room's `WarpTravelTracker` (`markArrived` in
  `receiveHandedOffHull`). `PixiRenderer.drawWarpFx` feeds such a hull to the
  existing `WarpFx` (gate `render/warpFxGate.ts`): spool glow, departure and
  arrival flash.
- **The view follows (S7/S8).** `transit_ready` carries the moved `shipIds`
  for a spectator seat. The existing handler takes the same room change with
  one `if` (`net/fleetWarpFollow.ts` `isCommanderFleetFollow`): the local
  ship's trip (`beginTravel`, travel-out wait) is skipped and the load curtain
  covers the switch; `joinAsSpectator` seeds pose and interest at
  `spawnX/spawnY`. Once the ships are in the new mirror,
  `consumePendingFleetArrival` hands `gameRafLoop` their ids and centroid:
  `IRenderer.selectFleetShips` (the one selection) and a camera glide.
- **UI.** In Command view the drawer's Warp here sends `shipIds` = the
  selection (`app/fleetWarp.ts`); with nothing selected it is disabled and
  says "Select ships to warp". Fly mode is unchanged (the flown ship warps).
- **E2E.** `tests/e2e/rts-fleet-warp.spec.ts`: box-select two parked hulls,
  Map → Warp here, spool bar, land in the neighbour in Command view with both
  ships selected; abort keeps them; the empty-selection gate. It runs in real
  galaxy sectors no other spec joins (a warp needs a graph neighbour and the
  far room) and speeds the source sector with the `timeScale` join option
  (honoured there because the E2E server sets `EQX_ALLOW_DEV_OVERRIDES=1`).

### The physics slot pool (a hard limit today)

Each `SectorRoom` owns ONE fixed `SharedArrayBuffer` of `MAX_ENTITIES` = 5120
slots (`sabLayout.ts`, 36 B each, ~184 KB), shared by players, parked hulls and
every swarm entity (asteroids, drones, structures, scrap, wreck pieces). Slots
come from the room's `freeSlots` stack (filled once in `onCreate`). The worker
and other per-room tables are sized to it (`aiInputPending`, the swarm packet
cap), and the lag-comp `SnapshotRing` has its own smaller fixed capacity (a
full ring silently skips `registerEntity`). When the pool is empty:

- a fresh join is refused (`client.leave(1001)`);
- `restoreLingeringHullsFromSnapshot` logs `no free slot for lingering-hull
  reconstruction` and skips the row;
- a cross-sector hull hand-off (teleporter or fleet warp) checks the far room's
  `canReceiveHull` first and leaves a hull that can't fit where it is (built,
  S3).

Making more room, smallest first: (1) let load-shedding free slots (it already
sheds out-of-view drones); (2) make the pool grow: a growable `SharedArrayBuffer`
(`maxByteLength`, length-tracking views) plus resizing every table sized to
`MAX_ENTITIES` in the worker and broadcaster, a bigger change touching the
physics worker.

## 5. Tests

- Brain: `WingmanBehaviour*.test.ts`, `intentToControlBits.test.ts`.
- Subsystem: `FleetCommandSubsystem*.test.ts`, `FleetStatusStream.test.ts`.
- Room: `tests/integration/sectorRoom/` `ownedShipsAiPilot` (Part B), `fleetCommandMessages`,
  `wingmanMovesParkedHull`, `wingmanFights`, `wingmanBoost`, `pilotLedSquad`,
  `commandDefaultJoin`, `fleetWarp` (S3 hand-off), `teleporterAcross`.
- Client units: `commandPointerRouter`, `tapAction`, `fleetSelection*`,
  `FleetOverlay*`, `fleetPick`, `FleetPanel`, `fleetStatusIngest`,
  `gameRafLoop.orders`, `protocol`.
- E2E: `tests/e2e/fleet-command.spec.ts` drives the whole loop in a browser
  (two parked hulls via a `newShip=1` rejoin; box-select, right-click move,
  hold fire, squad, patrol pick, Stop, Fly). It projects hulls to the screen
  with the DEV hook `__eqxWorldToScreen` (main-thread renderer, `?worker=0`).
  `tests/e2e/spectator-mode.spec.ts` covers the command-view join and the
  middle-drag camera pan. `tests/e2e/rts-fleet-warp.spec.ts` covers fleet
  warp (§4b).

## 6. Not done yet

- A phone-viewport E2E of hold-then-drag (the router and tap logic are unit
  tested).
- Fleet persistence across restarts is a separate slice
  (`SectorPersistence` / `FleetCommandSubsystem`).
- Labels are configurable later (TODO). Today (RTS Part A): friendly ships
  (the one you fly and your fleet) carry none, another player's AI-flown ship
  gets the AI pilots' `AI XXX` callsign, a pilot keeps their name. The client
  has no alliance data, so "friendly" means yours for now.
- Shield % for parked hulls still rides `fleet_status` (no per-ship shield
  carrier); it can move once one exists.

## 7. Zone rules in full

The zone CLAUDE.md files keep the RTS rules in a few short lines (the 2026-11-14
CLAUDE.md diet: rules only there, detail in a guide). This is the full text
they carried before the AI-pilot stack merge, kept as written.

### Core: the wingman brain (`src/core/CLAUDE.md`)

- **Wingman brain (RTS command layer, slices 2 + 8, 2026-11-14; not yet wired).** `ai/WingmanBehaviour.ts` flies a player-owned ship nobody is piloting: a MODE (`defend`; `patrol` = closed loop over 2–16 waypoints; `escort` = wedge slot 1 behind-starboard of another ship in its travel frame, velocity-matched, defends where it lost it; `hunt` = chase what `WingmanWorldView.nearestHostile` returns within `roleSensorRange(aiRole, fireRange)`, else defend; `retreat` = fly to a point, then become `defend`), an optional ORDER (`move` / `stop` / `attack`, movement only), a STANCE (in the brain its only effect is that a `holdFire` hunter does not chase; firing by stance is server-side, slice 5, see `src/server/CLAUDE.md` "Wingmen fight"). A finished order resumes the mode FROM WHERE THE SHIP IS (defend/hunt: the post becomes the current spot; patrol: the nearest waypoint; `stop` brakes in place, never steering for the predicted point, and holds the spot it halts on; the brake pushes down to `brakeBand(stats)` = half what one key held for `CONTROL_HOLD_S` (the 10 Hz re-plan) removes, not 2 % of max speed, so nothing crawls on: RTS stop drift 2026-11-14, lock `tests/integration/sectorRoom/wingmanStopSettles.test.ts`). Morale: `reportDamage` → `MoraleTracker` → seeded `rollMorale` (role weights, seed = the ship's numeric id); FallBack / Flee drop the order and run 2× / 5× the guard radius away from the threat, then resume; the owner's next order/mode cancels it. Target CHOICE for hunt lives behind the view hook, not in the brain (targeting slice). **Fighting faces the target (2026-11-14):** engaging within `max(2 × attackStandoff, fireRange)` and not `holdFire`, the brain sets `intent.face` + `faceAngle` (the target led by the primary gun's `muzzleSpeed`, shooter frame, as an NPC leads); `intentToControlBits` then turns the nose there and only thrusts / reverses along it. Before, the nose followed the stand-off velocity, so a fixed gun rarely bore and backing off from a closing target turned the tail to it. Lock: `WingmanBehaviour.modes.test.ts` "keeps its nose on a target that closes in". It implements the sibling `IWingmanBrain`, not `IAiBehaviour`, because it outputs PLAYER CONTROL BITS (`wingman/types.ts` `WingmanControls`), never impulses (owner rule: AI ships fly with player controls only, same stats). `wingman/intentToControlBits.ts` is the one desired-velocity → keys adapter. Callers pass size-dependent radii from `shipTuning` (#18) and `reverseAccelFor(kind, World.getBodyMass(id))`. Alloc-free per tick. **Formation role (slice 15b, squads):** `setFormationSlot(leaderId, slot, shape, count, spacing)` / `clearFormation()` overlay the mode: with no order a member holds its `formation.ts` slot round the leader (travel frame = leader velocity; a parked leader's nose via the optional `WingmanPoseOut.angle`), velocity-matched with the escort station-keeping (`keepStation`), activity `formingUp` / `guarding`; `setLeaderTarget(id)` makes it engage the leader's target unless `holdFire`; an individual order wins and then the member REJOINS its slot (a `stop` brakes, then rejoins). Lock: `WingmanBehaviour.test.ts` + `WingmanBehaviour.modes.test.ts` + `WingmanBehaviour.formation.test.ts` (a real fighter body driven through `World.applyInput`), `wingman/intentToControlBits.test.ts`.

### Server (`src/server/CLAUDE.md`)

#### Fleet command / wingmen (RTS command layer, slices 3–4, 6b, 7, 9)

- `fleet/FleetCommandSubsystem.ts` holds one `WingmanBehaviour` per AI-flown owned ship (the lingering hulls, slice 4) over injected hooks (`ownerOf`, `readPose`, `postInput`, optional `canBoost` / `resolvePoseInto`).
- **Commands are owner-checked PER ID through `ownerOf`**; foreign / unknown ids drop silently; at most `FLEET_MAX_IDS_PER_COMMAND` (64) ids are read; squads are 2–24 ships (data only for now).
- **Re-plan at ~10 Hz** (`FLEET_REPLAN_EVERY_TICKS` = 6, staggered by attach order); between re-plans the worker holds the last INPUT (input-queue rule #3). Output is PLAYER control bits through the pilot's INPUT command, never an AI intent.
- **Boost goes through the pilot's energy gate** (`canBoost`), re-checked every tick while held.
- Size-dependent radii from `shipTuning` (`guardRadiusMin`, `wingmanArrive`, #18); stats via `wingmanConfigFor(kind, statAlloc, fireRange?)` (also carries `aiRole` for hunt sensor range and morale weights).
- **Modes (slice 8):** `setMode(caller, ids, mode, { x?, y?, route?, escortId? })` mirrors the `set_mode` wire message. An escort target must be a ship the caller owns (`ownerOf`) or the one they fly (optional `pilotShipOf` hook), and never the ship itself; otherwise that ship defends where it is. Hunt asks the optional `nearestHostile(shipId, x, y, range, out)` hook (target choice belongs to the room / targeting slice).
- **Squads fly in formation (slice 15b):** members hold `formation.ts` slots on the squad LEADER (`formSquad(caller, ids, shape?)`, slots re-assigned on form / leader change / member removal, spaced by the largest member's `stationSpacing`). A command whose ids cover every AI-flown member is SQUAD-WIDE: an order goes to the leader only (members' orders cleared), a mode becomes `squad.mode` (flown by the leader, re-applied to any new AI leader), stance goes to all. A subset: orders go to those ships, which rejoin their slots after; a MODE takes those ships out of the squad. Members follow the AI leader's `targetId` per stance. **Pilot-led:** if `pilotShipOf(owner)` is a squad member that is not attached, it becomes `leaderId` and the members form up on it (resolved through the room's `resolvePoseInto`; attached ships resolve through `readPose`); on release (re-`attach`) it leads as AI on the squad mode. The room must call `detach(id, { keepSquad: true })` when the owner takes a member's helm, and `forgetSquadMember(id)` when a pilot-flown member dies / is abandoned. `statusFor` rows carry `squadLeaderId`. Lock: `FleetCommandSubsystem.squads.test.ts` (real `PhysicsWorld`, input held between re-plans like the worker).
- **Group moves spread (RTS stop drift, 2026-11-14):** a `move` that sends 2+ ships (loose ships and whole squads' leaders) to one point gives each its own spot (`spreadMove`: hex cluster spaced by the largest mover's `shipTuning(kind).flockSeparation`, #18; outermost ship picks first, nearest its place in the group), through the entry's reused `moveOrder` (no allocation). Sent to one point they arrived hull to hull and shoved. Lock: `FleetCommandSubsystem.test.ts`, `tests/integration/sectorRoom/wingmanStopSettles.test.ts`.
- Kill switch `EQX_DISABLE_WINGMEN=1` (attach is a no-op). Lock: `FleetCommandSubsystem.test.ts`.
- **Fleet warp** (`engage_transit.shipIds`) is a `TransitOrchestrator` branch keyed per GROUP, never a fleet order: its only drop point is `detachWingman` → `dropHull`; every fleet order / mode / stance handler calls `fleetCommandIssued`, and `reclaimLingeringHull` calls `noteTakeControls` before its detach. Story: [fleet-command](../../src/server/fleet-command.md) "Fleet warp".
- **Wired into `SectorRoom` (slice 4):** every LINGERING hull is AI-flown. `attachWingman(id)` runs at every entry into `lingeringSlots` (spectate/pilot-swap displace, onJoin fresh-spawn displace, snapshot restore, cross-sector `receiveLingeringHull`, after the REKEY/SPAWN) and `detachWingman(id)` at every exit (reclaim BEFORE the REKEY back, quiet teleporter removal, abandon→scrap, lingering death via `onLingeringHullDeath`, `evictOwnerlessShip`). Adding a new `lingeringSlots.set` / `.delete`? Call the matching helper next to it. Detach posts neutral controls so a queued wingman INPUT can't become the reclaimed hull's held input.
- **The wingman's INPUT** goes to the hull's lingering slot at `inputTick = serverTick` (one reused command object); `fleet.tick(serverTick)` runs once per `update()`, beside `runAiTick`. Default brain = Defend at the parking spot, Defensive stance, so a parked hull stays put.
- **Boost (slice 4b):** `canBoost(id)` = `canAfford(hull.energy, BOOST_TICK_COST)` on the HULL's own pool (the pilot's `InputHandler` gate). `postWingmanInput` puts the hull in the ONE `boostingPlayers` set, keyed by shipInstanceId (pilots are keyed by playerId; the id spaces never collide, and a pilot shares one playerId with their parked hulls so hulls must never use it; cleared in `detachWingman`), and `tickEnergy` drains `BOOST_TICK_COST` a tick for each (a hull entry resolves via `lingeringSlots` + `isLingeringHull`, #17). **Flame carriers (RTS Part A S2):** the broadcaster's lingering loop pushes an alive hull's shipInstanceId into snapshot `thrustingIds` / `boostingIds` from its slot FLAGS input bits, the same carriers every ship uses (the `boostingPlayers` snapshot filter keeps playerIds only, so no duplicates). Lock: `tests/integration/sectorRoom/wingmanFlameIds.test.ts`. The lingering `lastInput` path stays until the client switches over. The boost bit reaches clients through the slot FLAGS word (slice 4c), and the renderer draws parked-hull boost exhaust from it. Since slice 5 an AI-flown hull's energy regenerates (`tickEnergy`, wingman hulls only) and its weapon fire spends it. Lock: `tests/integration/sectorRoom/wingmanBoost.test.ts`.
- **Pilot-led squads in the room (slice 4b):** `pilotShipOf(pid)` returns the flown ship's shipInstanceId (the fleet's id space); `resolvePoseInto` resolves an active ship by shipInstanceId as well as by playerId and sets `angle`. Reclaim (`reclaimLingeringHull`) calls `detachWingman(id, true)` → `fleet.detach(id, { keepSquad: true })`; the active-hull `SHIP_DESTROYED` handler and `abandonShipToScrap` call `fleet.forgetSquadMember`. The client names its own active ship by playerId: `set_mode` maps an escort of it to the shipInstanceId, and the status stream maps it back (`FleetStatusStream` `wireShipId`). Lock: `tests/integration/sectorRoom/pilotLedSquad.test.ts`. A live upgrade of a lingering hull pushes `SET_STAT_MUL` to its `linger-<id>` body and re-attaches the brain (the order is dropped); a restored hull's body gets its multipliers at restore. A teleporter swap moves the brain's guard post with the hull.
- **Wingman state persists across a restart (slice 9):** each `lingeringHulls[]` row carries the brain's OPTIONAL `mode` / `modeData` (guard post, patrol route, escort id, retreat point) / `stance` / `squadId` (`FleetCommandSubsystem.exportShip`), and the sector snapshot an optional `squads[]` (`exportSquads`: id, owner, leader, members, shape, squad mode + data). Direct orders are never saved. Additive optional fields, so **no `CURRENT_SCHEMA_VERSION` bump** (a bump discards every saved sector, players' structures included; an old v7 row hydrates with default brains). Hydrate order: `restoreLingeringHullsFromSnapshot` attaches every brain, THEN re-applies each row's job (`restoreShip`, so an escort target restored later in the batch counts), then `SectorPersistence.hydrate` calls `restoreFleetSquads` → `restoreSquads`. Every entry is zod-checked (`fleet/fleetPersistence.ts`) and invalid parts drop; `restoreShip` / `restoreSquads` re-run the live checks (hull still owned by its owner, escort target owned by the owner and not itself / a member, members attached + owned + not already squadded, 2–24 left or the squad drops; a restored id never collides with a later `formSquad`). A cross-sector hand-off (teleporter, fleet warp) carries stance + squad; the job becomes defend where it lands. Hydrate skips a row whose roster `lastSectorKey` is another sector. Escorting the owner's ACTIVE ship can't survive (the pilot isn't there at hydrate) ⇒ defend in place. Locks: `FleetCommandSubsystem.persist.test.ts`, the lingering describe in `SectorPersistence.structures.test.ts`, `tests/integration/sectorRoom/wingmanPersist.test.ts` (two-boot).
- **Test hooks:** `_internals.fleet` (the owner-checked API), `_internals.sendFleetStatus()` (send the status stream now). Locks: `tests/integration/sectorRoom/wingmanMovesParkedHull.test.ts`, `fleetCommandMessages.test.ts`.
- **Network handlers (slice 6b):** `fleet_order` / `set_mode` / `set_stance` / `form_squad` / `disband_squad` parse with their strict schema (`malformed.record` on failure) and route to `this.fleet` with the caller's playerId, rate-limited by `fleetMsgAllowed`. A selection id equal to the caller's playerId (their ACTIVE ship, which they fly) is never attached, so it drops silently. `command` is an alias of `spectate` (both call `enterSpectate`). **Command-view join (slice 10):** join option `startMode: 'command' | 'fly'` (absent = `fly`, so transit arrivals and every test room keep flying; galaxy rooms only). `command` puts the player in `pendingCommandStart`; `drainPendingJoin`'s activation branch then calls `startInCommand` → `enterSpectate` (the hull parks as an AI-flown wingman) + a `control_mode { mode: 'command' }` message; cleared on leave and on reclaim. Lock: `tests/integration/sectorRoom/commandDefaultJoin.test.ts`. Hooks: `pilotShipOf(pid)` returns the flown ship's shipInstanceId while they fly a live ship (slice 4b; was the playerId); `resolvePoseInto` resolves lingering hulls, active ships (by playerId or shipInstanceId) and swarm entities. `resolvePoseInto` also takes the client's wire id (`swarm-<entityId>`, what an attack order names).
- **Wingmen fight (slice 5): the PLAYER fire pipeline, never `AiFireResolver`.** A parked hull is a player's ship, so it has a pilot's powers and no more (owner rule): `wingmanLocks` (a second `LockSubsystem`, keyed by shipInstanceId, groups in MAN, separate so `npcLocks` never iterates a wingman) → `WeaponMountTicker.tickHull` (the pilot's mount-aim rule) → `PlayerFireResolver.fireHull` (lock gate, mount bearing, cooldown, energy, damage upgrade; no `hit_ack`, no lag-comp rewind). The player side keeps ONE resolver; `locksFor(id)` / `lockOwner(id)` dispatch the gate, the aim and the bearing test for a hull id. Lock target hostility, failsafe commits and lock refreshes go through the hull's OWNER. Target choice (~10 Hz, `tickWingmanTargets`) is the pure `fleet/wingmanFireTarget.ts` `pickWingmanFireTarget`: holdFire never; defensive = explicit attack target, else (Part B slice 4: retaliation is the AI pilot brain's `markHostile` ledger, §0), else an owner-hostile inside `guardRadiusMin`; aggressive = its own target, then those, then any owner-hostile in weapon reach; a retreating ship only returns fire. Candidates come from `nearestOwnerHostile(owner, …)` (NPC ships via `npcHostileTo`, built structures via `relationOf`; never players; ONE swarm scan per owner per tick, cached), which is also the hunt brain's `nearestHostile` hook. Players are targeted only by an explicit order or retaliation (`p:` lock). **Owner mirror:** a hit from a hull counts for its owner (`hostileActorOf`: LeafDeps → `markHostile` / faction escalation; `applyDamage` → standing, economy, NPC-base hostile acts). **Morale:** `applyDamage` calls `aiController.noteDamage` for an owned hull (Part B slice 4, §0), with the HULL the hit took (hull before − after), never the raw damage: shield hits alone never roll a retreat (RTS take 2026-11-14: wingmen fell back at hull 100 %). **`fireHull` fires from the LIVE pose, never the lag-comp ring:** a scene / restored hull is `registerEntity`'d in the ring but never recorded, so its "rewound" pose read (0, 0, angle 0) and every bolt left the world origin heading north (same take: 2 hits on the robots, 29 on the wingmen). Lock: `tests/integration/sectorRoom/wingmanFightsRobots.test.ts` (5 hunting wingmen vs the `showcase-rts` cubes; NPC control: 5 drone fighters win in ~9 s, losing 1). A lingering hull's snapshot `mountAngles` are its own (keyed by shipInstanceId), not its owner's active ship's. Laser shooter ids are the shipInstanceId (the client falls back to the wire endpoints). Lock: `tests/integration/sectorRoom/wingmanFights.test.ts`, `wingmanFireTarget.test.ts`, `FleetCommandSubsystem.test.ts`.
- **`fleet_status` stream (slice 7):** `fleet/FleetStatusStream.ts` rides the selection-stats timer, every other fire (~2.5 Hz). Each session gets ONLY its own ships (`statusFor` + hull %, morale roll, move destination, patrol route, escort id, and shield % appended at index 13, optional on the wire) as compact tuples (`shared-types/messages/fleetStatusMessages.ts`; enum tables locked against core). A message, not a snapshot field (#16): the snapshot goes to everyone, a wingman's orders are private; every send is the WHOLE owned list (the client replaces), so a late joiner converges within one period. Only a repeat EMPTY send is skipped. Off the physics tick (tuple allocation tagged `TODO: alloc-debt`). **After a command (RTS review 2026-11-14):** every accepted fleet command handler calls `fleetStatusSoon.request(session, serverTick)` (`fleet/FleetStatusSoon.ts`); the room flushes it right after `fleet.tick`, sending that owner's status `FLEET_REPLAN_EVERY_TICKS + 1` ticks later (once every addressed brain has re-planned, so the ACTIVITY is already the new one; one send per burst). Before, the panel read "Guarding" for up to ~1 s after a move. Lock: `tests/integration/sectorRoom/fleetStatusAfterCommand.test.ts`, `FleetStatusSoon.test.ts`.
- **Wingman input on the wire (slice 4c):** a lingering hull's snapshot `lastInput` is read from its slot FLAGS word (the worker mirrors the wingman's last-applied INPUT bits there), exactly like an active ship's. Held bits ride every snapshot, idle bits are absent (the same stateless rule as every ship, see Phase 3 above). Lock: `SnapshotBroadcaster.lingeringInput.test.ts`.

### Client (`src/client/CLAUDE.md`)

#### One ship list groundwork (RTS Part A S0)

- **Which key a wire ship lives under** is `net/shipMirrorKey.ts`, the ONE rule both `snapshotShipRouter` and `syncMirror` use: active ⇒ playerId; the own welcome ship while pending-join ⇒ playerId; any other inactive hull ⇒ shipInstanceId; own ACTIVE entry while spectating ⇒ shipInstanceId (the hull it is becoming; never the playerId). With no welcome ship id (shipless spectator join, a rebind whose hull is gone) no own hull is ever claimed by playerId. Lock: `shipMirrorKey.test.ts`.
- **"The ship I'm flying" / "owned by me"** are `render/shipOwnership.ts` (`isShipIAmFlying`, `isOwnedByMe`, `shipOwner`), pure and mirror-only (worker-safe). Never compare `id === localPlayerId` or `ownerPlayerId === localPlayerId` inline again. Ship entries carry the wire's `isActive` and `ownerPlayerId` (`ShipRenderState`); liveness itself is the shared `src/core/entity/shipLiveness.ts` (#15, #17).
- **Remote ships' input bits and offsets (RTS Part A S1).** `preResetRemoteShips` keeps one reused `RemoteInput` per remote (`held` false when the snapshot carried no bits: absent = IDLE, the server's `shouldIncludeLastInput` rule; never "keep the previous bits", since the coalescer drops snapshots and a dropped release would stick on); `applyRemoteShipInputs` is the one forward-prediction step (held bits only, hysteresis guard, `STAGE_3_MAX_LOOKAHEAD_TICKS`). The render offsets (`remoteLerpOffsets.ts`) spring x, y AND angle (`REMOTE_ANGLE_OFFSET_HALF_LIFE_MS` 40 ms, the same for parked hulls since S3), stepped per frame by `stepRemoteShipOffset`. Locks: `remoteShipTurnSmoothing.test.ts` (steady turn ≤ 1.25 ticks of rotation per frame, angvel-0 contrast, lookahead cap), `tests/integration/sectorRoom/remoteInputBits.test.ts` (two-sided), `tests/e2e/remote-ship-held-thrust.spec.ts`.
- **Remote ship bodies** are spawned only by `ColyseusClient.ensureRemoteShipBody` and dropped only by `dropRemoteShip(key, 'gone' | 'outOfWorld')`, which also clears every per-ship prediction map (offsets, last inputs, lookahead counter, prediction guard, arrival snap). Add any new per-remote-ship map to `dropRemoteShip`.

#### RTS command view — fleet selection (slice 13a)

- Command view is `pilotMode === 'spectator'` for now (`setSpectator` → `CommandPointerRouter.setEnabled`). While on (and no galaxy overlay / placement), BOTH pointer paths go through the pure router (`render/input/commandPointerRouter.ts`); its `camera` actions run `PixiRenderer.cameraPointer` with the camera's `wasTap` IGNORED. Tap on an own ship selects it (shift toggles); any other tap falls through to the inspect select; left-drag (touch: hold, then drag) draws a box; mouse right-click gives an order (attack a non-own, non-asteroid entity under the cursor, else move). Pointers are captured per gesture in command view (both paths) and the native context menu is suppressed (`decideContextMenuPlacement` 4th arg).
- **ONE selection (RTS Part A).** The renderer owns it: `_selShips` (own ships: the active ship by playerId + own parked hulls (`isParkedHull` + `isOwnedByMe`); pure helpers in `render/fleetSelection.ts`, pruned per frame) plus the FOCUS `_focusId/_focusKind` (the entity whose details panel shows: the one you clicked). Rule `focusSurvives`: with ships selected the focus is one of them or null; with none it can be anything tapped. Change it only through `PixiRenderer.setSelection` / `setFocus`. Every selected ship and the focus get the SAME `SelectionBracket` marker (screen space, one Graphics, drawn in the ticker); never add a second marker style. Zustand mirrors it as ONE shape `selection: { ids, focusId, focusKind }` (`setSelection`, ids only, #2); the server `select_entity` stats stream follows the focus. Published as `RendererFeedback.fleetSelSeq/fleetSelIds` (the ships; ids array replaced only on change), `selectedPickId/Kind` (the focus) and `orderSeq/orderKind/orderX/orderY/orderTargetId`; `gameRafLoop` writes the store in one `setSelection` call when either part moves, and sends each new order once via `sendFleetOrder` (skipped with an empty selection; still logs `fleet_order`). `H` in command view (`SpectatorPanInput` `onHold`, not from a text field) sends `stop` for the selection. E2E: `data-fleet-sel` (csv), `data-fleet-sel-count`, `data-fleet-order-seq`, `data-fleet-order-kind`; DEV hook `__eqxWorldToScreen(x, y)` (`?worker=0`) projects a game point to canvas px so a spec can click/box a ship where it is drawn. Whole-loop E2E: `tests/e2e/fleet-command.spec.ts`; in command view a LEFT drag is a box, so specs pan with a MIDDLE drag or WASD. Story: [docs/architecture/fleet-command.md](../../src/client/fleet-command.md).
- **Phone tap-orders (slice 12).** The router's `tapSelect` carries `pointerType`; `PixiRenderer.commandTap` asks the pure `render/input/tapAction.ts` `decideTapAction`: an own ship selects (any pointer); a touch/pen tap with a selection ORDERS per `fleetOrderMode` ('move' → the tap point, even on an entity; 'attack' → the attackable entity under it, else nothing); mouse left-tap is unchanged (inspect, clearing the selection). The mode reaches the renderer via `IRenderer.setFleetOrderMode` (worker `SET_FLEET_ORDER_MODE`), seeded at renderer creation and pushed by an `App.tsx` effect. Orders reuse the feedback `orderSeq` path. **Hold cue:** `CommandPointerRouter.holdArmedAt(nowMs, out)` (no timer) gives a touch held still ≥ `HOLD_THRESHOLD_MS`; FleetOverlay draws an expanding ring there (pointer stamps are `Date.now()` on both paths, so the renderer polls with `Date.now()`). The panel's command seam is plugged at boot by `fleet/installFleetCommandSenders.ts`. Locks: `tapAction.test.ts`, `commandPointerRouter.test.ts`, `FleetOverlay.test.ts`, `installFleetCommandSenders.test.ts`, `protocol.test.ts`.
- `render/FleetOverlay.ts` is ONE screen-space `Graphics` (order lines, drag box, order flash, hold cue, pick previews; no ship marker: that is `SelectionBracket`) — keep it one draw call (fleet-fight sits near the draw-call budget); nothing per ship. Locks: `fleetSelection.test.ts`, `FleetOverlay.test.ts`, `SelectionBracket.test.ts`, `store.selection.test.ts`, `contextMenuPlacement.test.ts`, `protocol.test.ts`.
- **The selection markers and the overlay are drawn in the Pixi ticker, right after `camera.tick`** (`PixiRenderer.drawFleetOverlay`), never in `update()`: `update()` runs before the frame's camera tick, so a screen-space overlay projected there lags one frame of camera motion (markers ~20 px off their ships during a pan, then the ships "snap in"; RTS review 2026-11-14). Any new screen-space overlay that follows world objects must project at the same point. Lock: `tests/e2e/fleet-overlay-camera.spec.ts` (DEV hook `__eqxFleetRingProbe`, `?worker=0`: first selection marker's drawn centre vs its ship sprite's screen point, captured in the ticker).
- **Take controls answers the swap's join handshake.** The server reclaims a parked hull through `pendingJoin` (`isActive=false` until `client_ready`); `sendClientReady` is latched once per room join, so the pilot-swap branch of the `welcome` handler sends `client_ready` itself. Without it the flown hull stayed "joining" for the 30 s watchdog (no own-ship energy / fire-control / wallet slices, hidden from other players). Lock: `tests/e2e/rts-take-controls.spec.ts`. The server keeps a reclaimed hull in OTHERS' snapshots through the handshake (`PendingJoinRecord.inWorld`), so their clients re-key it instead of dropping it (lock `tests/integration/sectorRoom/pilotSwapVisibleToOthers.test.ts`). The camera glide ends on the LIVE follow target (`Camera.tick`), so follow takes over without a jump.

- **Squads + order lines (slice 15a).** The renderer cannot read `fleet/fleetStatus.ts` (it may be in a worker), so `gameRafLoop` posts a compact model via `IRenderer.setFleetOverlayModel` (worker `SET_FLEET_OVERLAY_MODEL`; built by `fleet/fleetOverlayModel.ts`, only when the status version moves). Per ship: `id, squadId, orderKind, destX/destY?, targetId?, escortId?, route?`, from the status fields `squadId`, `orderKind`, `orderX`, `orderY`, `targetId` (attack only), `escortId`, `route` (route/escort only while no direct order runs). Selection (`fleetSelection.ts`): a tap selects the WHOLE squad, a tap on a member of an exactly-selected squad narrows to that ship (`tapSelectOwn`), a box selects every squad it touches and shift adds a whole squad (`expandToSquads`); shift on a selected ship still removes just it. `FleetOverlay` draws, for SELECTED ships only, lines to the move destination, the attack target's current mirror pose (`resolveEntityPos`, alloc-free `swarm-<n>` parse), the escorted ship and the patrol loop: one stroke per colour on the same Graphics, capped at `MAX_ORDER_SEGMENTS` (256). Locks: `fleetSelection.squads.test.ts`, `FleetOverlay.orders.test.ts`, `fleetOverlayModel.test.ts`, `protocol.test.ts`.

#### RTS command view — the default; Command / Fly (slice 10)

- **Normal galaxy play starts in COMMAND view** (owner 2026-11-14): free camera over your fleet, every ship AI-flown. `buildJoinSpec` adds `startMode` via the pure `app/startMode.ts` (`resolveStartMode`: join-option override → `?startMode=` → room default; `command` only for real `galaxy-*` rooms, never `galaxy-test` / engineering rooms; none for a spectator join). "Pilot that ship" from the galaxy map (`useShipSwapDispatcher`) sends `fly`. The join itself runs the normal ship handshake (readiness unchanged); at the arrival flip the server parks the hull and sends `control_mode` → `ColyseusClient.enterCommandFromServer` (flip to `spectator`, then the same local drop as a toggle). E2E helpers `launchTestClient` / `launchGalaxyTestClient` pass `startMode=fly`.
- **Names:** the stored field stays `pilotMode` (readiness gate, `setSpectator`, e2e probes, ~70 sites); the player-facing `ControlMode` (`fly` | `command`) is the pure selector `selectControlMode`. Never store it twice. Before a join the store reads `fly`.
- **Toggle** (`PilotSpectatorToggle`, test ids unchanged: `spectator-toggle` = Command, `pilot-toggle` = Fly): Command → `sendCommand` (`command` message); Fly with exactly one own parked ship selected takes it, else opens the own-ship menu. **Double tap / click** an own parked ship in command view (`render/input/doubleTap.ts` in `PixiRenderer.commandTap`) → `RendererFeedback.takeControlsSeq/takeControlsId` → `gameRafLoop` → `fleetCommands().takeControls`. Death still drops to command view. `SpectatorIndicator` reads "Command view". Locks: `startMode.test.ts`, `PilotSpectatorToggle.test.tsx`, `SpectatorIndicator.test.tsx`, `doubleTap.test.ts`, `ColyseusClient.commandJoin.test.ts`, `gameRafLoop.orders.test.ts`, `protocol.test.ts`, `tests/e2e/spectator-mode.spec.ts` (command-view join).
- **Fleet warp:** in Command view "Warp here" sends the ONE selection as `engage_transit.shipIds` (`app/fleetWarp.ts`; nothing selected ⇒ disabled + "Select ships to warp"; Fly mode unchanged). The commander follows through the existing `transit_ready` handler (an `if` skipping only the local-ship trip, `net/fleetWarpFollow.ts`) and the arrived ships are re-selected via `IRenderer.selectFleetShips`; never a second room-change path. Guide: [fleet-command §4b](../../src/client/fleet-command.md); E2E `rts-fleet-warp.spec.ts`.

#### RTS command view — AI-flown hulls are ordinary ships (RTS Part A S3)

- **ONE ship list.** A parked / AI-flown hull (wire `isActive=false`) is an ordinary `mirror.ships` entry under its shipInstanceId (`shipMirrorKey`); `RenderMirror.lingeringShips`, `LingeringPredBodyManager`, `lingeringSprites` / `updateLingeringShips` / `decideLingeringSpriteAction`, the 0.75 alpha and the `linger-` client body ids are DELETED. Never add a second hull map or a fallback lookup.
- **Prediction = the remote-ship path.** The router (`snapshotShipRouter`) re-keys `snap.states` (hull states ride under the sid), seeds a hull's entry (pose, owner, `isActive`) and drops a hull missing from a snapshot through `dropRemoteShip` (hull lifetime is the router's; `syncMirror`'s departed sweep skips parked hulls and never purges hostility for them). Bodies: `spawnRemoteShipBodies` (per snapshot, every remote ship) → `ensureRemoteShipBody`, then `preResetRemoteShips` / `applyRemoteInputs` / `computeRemoteLerpOffsets` / the `updateMirror` offset loop, exactly like another pilot's ship. With no reconciler (command view is the default) `handleSnapshot` still runs `preResetRemoteShips` + the offsets (it used to teleport remote bodies with frozen turrets).
- **B2 — one spawn rule:** a remote body (pilot or hull) spawns only from a real SNAPSHOT pose: `ensureRemoteShipBody` takes the snapshot ship-state type; `syncMirror` (schema: no pose) never spawns a body or writes pose onto an existing entry, and `tryInitPredWorld` no longer back-spawns remotes. Locks: `ColyseusClient.lingeringJitter.test.ts`, `spectateOwnHullDrawnPose.test.ts`.
- **Shared apply paths:** level (`applyShipLevels`), activated mounts (`applyActivatedMounts`), mount angles (`preResetRemoteShips`), flames (`thrustingIds` / `boostingIds`, S2), shield (`applyParkedHullShieldDown`, parked hulls only; an active ship's stays event-driven). Drawn by `shipSpriteUpdater` (kind change ⇒ rebuild via `decideShipSpriteAction`, fallback kind until the schema brings one).
- **Locking:** another player's ship is lockable whoever flies it: the lock line, `lockSelected`, `contactRows` and `TargetAction` key every ship `p:<mirror key>` (a hull's shipInstanceId) and skip only `isOwnedByMe` (the ship you fly + your fleet); the server resolves both (#15, [fire-control](../../src/client/fire-control.md)).
- **Radar, far-zoom icons, labels (owner decisions):** a ship an AI pilot flies shows like any ship. Radar: every ship is a `player` contact (the retired `lingering` category is stripped from old saved prefs by `RadarPrefsSchema`), your own fleet in `OWN_SHIP_COLOUR` (the far icons' "you" white), others in the player colour. Far-zoom icons: every ship, yours (`isOwnedByMe`) as own. Labels: friendly ships (the ship you fly + your fleet; the client has no alliance carrier) carry none; another player's AI-flown ship (`isParkedHull`) gets the AI pilots' rule (`formatAiShipCallsign`, drone style, off with NPC callsigns); a pilot keeps their name. Labels configurable later (TODO). Locks: `HaloRadar.ships.test.ts`, `FarZoomIcons.test.ts`, `Labels.test.ts`.
- **Gates that keep pre-S3 behaviour** use `isParkedHull` (`render/shipOwnership.ts`, #17): `drawWarpFx`, `pickEntity` (kind `'lingering'`), `isOwnShipPresent`, `localCameraKey`, `PilotSpectatorToggle`, `EntityStatsPanel`, `data-ship-positions` vs `data-lingering-positions`. The ship counter counts every ship.
- **Seamless hand-over (take / let go of the controls, any pilot):** a key change is ONE op, `ColyseusClient.rekeyShip(from, to)`: it MOVES the same entry object, its body (remote state carried; to local: dropped before `tryInitPredWorld`; from local: becomes a remote body) and per-ship prediction maps, and queues the pair on `mirror.pendingShipRekeys` (one-frame trigger, `perFrameTriggers`). Callers: welcome (`rekeyOwnShipFromHull`), Command / Spectate (`dropLocalShipForCommand`; `shipMirrorKey` keys the own ACTIVE entry while spectating by shipInstanceId), and the router / `syncMirror` via `net/shipRekey.ts` `findRekeySource` (entries carry `shipInstanceId`). `PixiRenderer.rekeyShip` moves sprite, art handle, turret cluster, health bar, label, FxEngines, FxShields, selection (`render/shipRekey.ts` `moveKey`) before the sprite pass. Never drop + recreate a re-keyed ship. Locks: `ColyseusClient.seamlessRekey.test.ts`, `render/shipRekey.test.ts`, `tests/e2e/rts-take-controls.spec.ts` (DEV `__eqxShipVisualProbe`, `?worker=0`).
- **Collision ids:** the server worker keys a hull body `linger-<sid>`; `collision_resolved` maps it to the bare sid in ONE place (`shared-types/shipBodyIds.ts` `wireShipBodyId`). Two-sided lock: `tests/integration/sectorRoom/lingeringHullCollisionIds.test.ts`.
- Turn smoothing lock: `remoteShipTurnSmoothing.test.ts` (steady turn ≤ 1.25 ticks of rotation per frame; angvel-0 contrast; lookahead cap).

#### RTS command view — fleet panel (slice 14)

- **Status** lives in the module singleton `fleet/fleetStatus.ts` (`applyFleetStatus(rows, {replace?})`, `getFleetStatus(id)`, a version counter), polled by `useFleetStatusVersion` at ~3 Hz, like `selectionStats`. Never Zustand, no positions. Its only writer is the `fleet_status` handler (`fleet/fleetStatusIngest.ts`, registered in `ColyseusClient`): zod-parse, decode the tuples, `applyFleetStatus(rows, { replace: true })`. Rows also carry `orderX`/`orderY`, `route`, `escortId` and `shieldPct` (shield stays here: no per-ship shield carrier for parked hulls). Hull % is NOT a status field: `syncMirror` copies room-state `health`/`maxHealth` onto every ship entry (`net/shipSchemaHealth.ts`) and the panel reads it there (polled with the status); the tuple's hull and morale slots are retired, never filled. Locks: `fleetStatusIngest.test.ts`, `ColyseusClient.shipHealth.test.ts`, `fleetStatusMessages.test.ts`.
- **Commands** go through `fleet/fleetCommands.ts`: `setFleetCommands(partial)` plugs in the network senders (`setMode(ids, mode)`, `setStance(ids, stance)`, `stop(ids)`, `formSquad(ids)`, `disbandSquad(squadId)`, `takeControls(id)`); all are no-ops until then except `takeControls` (`sendPilotShip`).
- **Pick on the map (slice 14b).** Patrol / Escort / Retreat don't send at once: the button sets the discrete Zustand `fleetPick` (`{kind, points, doneSeq}`), the panel/strip swap their controls for `FleetPickBar` (plain hint + Done / Back to post / Cancel), and an `App.tsx` effect pushes the kind via `IRenderer.setFleetPick` (worker `SET_FLEET_PICK`). The POINTS stay in the renderer (`render/input/fleetPick.ts`, pure, fixed `Float64Array`); while a kind is set, `PixiRenderer.applyPickRouterAction` routes every tap to `pickTap` (`decidePickTap`) and never changes the selection or draws a box. Patrol: each tap adds a waypoint (cap 16), FleetOverlay draws the closed loop + dots + line-drawn numbers on its one Graphics; Done (button → `doneSeq` → `commitFleetPick` / worker `COMMIT_FLEET_PICK`, Enter, or mouse right-click) needs 2+ points. Escort: the next tap on an own ship NOT in the selection. Retreat: the next tap is the point; "Back to post" sends retreat with no point (the server's default: the post). Escape / Cancel / an emptied selection / leaving command view end it. The renderer publishes `fleetPickPoints` (mirrored to Zustand on change) and `fleetPickSeq` + `fleetPickResult`; `gameRafLoop` sends each result once via `fleetCommands().setMode(ids, mode, {route | escortId | x,y})`. `set_mode` carries optional `x`/`y` (the retreat point; the server passes them only as a pair). Locks: `fleetPick.test.ts`, `fleetPickView.test.ts`, `FleetOverlay.pick.test.ts`, `FleetPanel.test.tsx` "fleet map picks", `gameRafLoop.orders.test.ts`, `protocol.test.ts`, `fleetCommandMessages.test.ts` (retreat point).
- **UI:** `FleetPanel` (desktop) / `FleetStrip` (`useIsCompact`) render in the `bottom-center` slot (`order={2}`, always mounted, null unless in game + spectator + a selection). `BottomControlPanel` hides (stays mounted, the death-flip rule) and its 1–9 hotkeys go quiet while `selection.ids` is non-empty. The touch sticks are mounted only while flying, so the strip never meets them. `fleetOrderMode` ('move' | 'attack') is the strip's discrete tap-order toggle. Rows show kind names and `describeActivity` text (`fleet/fleetView.ts`), never ids. Locks: `fleetStatus.test.ts`, `FleetPanel.test.tsx`, `BottomControlPanel.test.tsx` "FLEET SELECTED".
