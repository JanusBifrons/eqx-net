# Fleet command (the RTS command layer): internals

The player-facing story is [docs/features/rts-command.md](../features/rts-command.md).
This page is how it is built: which pieces own what, and why each boundary is
where it is. The zone CLAUDE.md files carry the rules in short
(`src/server/CLAUDE.md` "Fleet command / wingmen", `src/client/CLAUDE.md`
"RTS command view", `src/core/CLAUDE.md` "Wingman brain").

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
mount bearing, cooldown, energy and damage upgrades. Target choice
(`fleet/wingmanFireTarget.ts`, ~10 Hz) is where the stance applies. A hit from
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

## 5. Tests

- Brain: `WingmanBehaviour*.test.ts`, `intentToControlBits.test.ts`.
- Subsystem: `FleetCommandSubsystem*.test.ts`, `FleetStatusStream.test.ts`,
  `wingmanFireTarget.test.ts`.
- Room: `tests/integration/sectorRoom/` `fleetCommandMessages`,
  `wingmanMovesParkedHull`, `wingmanFights`, `wingmanBoost`, `pilotLedSquad`,
  `commandDefaultJoin`.
- Client units: `commandPointerRouter`, `tapAction`, `fleetSelection*`,
  `FleetOverlay*`, `fleetPick`, `FleetPanel`, `fleetStatusIngest`,
  `gameRafLoop.orders`, `protocol`.
- E2E: `tests/e2e/fleet-command.spec.ts` drives the whole loop in a browser
  (two parked hulls via a `newShip=1` rejoin; box-select, right-click move,
  hold fire, squad, patrol pick, Stop, Fly). It projects hulls to the screen
  with the DEV hook `__eqxWorldToScreen` (main-thread renderer, `?worker=0`).
  `tests/e2e/spectator-mode.spec.ts` covers the command-view join and the
  middle-drag camera pan.

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
