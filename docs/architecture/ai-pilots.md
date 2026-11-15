# AI pilots: how NPC ships fly

How the AI brain in `src/core/ai/` turns decisions into flight. Which sides fight whom is in [allegiances.md](allegiances.md); how the client stays in step is in [ai-lockstep.md](ai-lockstep.md). The rules are in [src/core/CLAUDE.md](../../src/core/CLAUDE.md#what-belongs-in-srccore).

## The virtual pilot: a player's controls only

An NPC brain never emits an impulse or an angvel snap. It picks a FACING and a WANTED VELOCITY, and `ai/virtualPilot.ts` (`pilotInputs`, pure, alloc-free, caller-owned `PilotState`) turns them into the keys a player would press (thrust, reverse, turn left/right, boost) as `AiIntent.input` bits. The worker runs them through `applyShipInput` with the NPC's own kind.

- **Boost shows like a pilot's:** `AiController.boostingSlot` remembers whether this tick's keys held boost; the room (after the disabled gate) puts it on the in-interest snapshot as `drones[].boost` (emit-when-true, #16), the client mirrors it to `SwarmRenderState.boosting`, and the engine exhaust draws the same boost flame a pilot's ship gets (`render/pixi/droneEngineInput.ts`). Thrust still follows speed (no key on the wire). Locks: `AiController.boost.test.ts`, `SnapshotBroadcaster.droneBoost.test.ts`, `snapshotRemoteSync.charging.test.ts`, `droneEngineInput.test.ts`.
- **Handling comes from the kind:** `makePilotHandling(kind, shipBodyMass(kind))`, the same mass a player's ship of that kind has (ship stats belong to the ship, never the pilot).
  - Snap turns stop on release.
  - Torque (capital) turns stop early on the predicted coast `ω/angularDamping`, and counter-turn when even that overshoots.
  - Throttle is bang-bang on the velocity error along the nose (reverse brakes).
  - `brakingSpeed(h, dist)` is the arrive ramp.
- **`leadTicks: 1`** predicts the pose one tick on (the server brain reads the last worker step).
- **Boost is energy-gated per NPC** with the shared `Energy.ts` helpers (`BOOST_TICK_COST`, the kind's `energyMax` / `energyRegenRate`; server-only state).
- **Every mode flies this way:** `HostileDroneBehaviour` uses it for combat, broadside, guard, patrol, move-to and flock. Its decisions (targets, ranges, fire gate) are unchanged.
- **Pace:** out of combat it chooses `CALM_CRUISE_FRAC` (0.45) of its cruise speed (the pace the retired `ai.thrust` gave); in combat it has full handling and boost.
- **Difficulty** knobs are the pilot's reaction latch and aim, never weaker engines.
- **Hold the line while a charge winds up:** a charge shot leaves down the barrel when its wind-up ends, so while `view.isCharging(self.id)` (any mount charging in the server's `WeaponMountTicker.charges`, set on `AiController.isCharging`; server-only, no wire) the combat brain flies nose-on to the lead at the target's velocity instead of its manoeuvre. Without it a robot orb on a strafing pass slid ~400 u in the 1.2 s wind-up and missed even a parked pilot (6 of 6). Locks: `chargeLaser.test.ts`, `attackRunTurnBack.test.ts`.
- **Start a wind-up only with room to hold it:** a brain whose gun charges in a locked direction pulls the trigger only at or beyond its attack run's pull-off distance (`shipTuning(kind).attackRunOvershoot`). Inside it the pass swings beside the target, and holding the line there parked a Robot Orb ~2.5 ship lengths off a parked pilot for the whole wind-up (a 1.27 s slow hold). Lock: `tests/unit/aiChargeWindUpRoom.test.ts`.

Locks: `ai/virtualPilot.test.ts` (real Rapier body, fighter and capital, with and without a tick of lag) and the `HostileDroneBehaviour*.test.ts` suites (keys via `ai/pilotTestKit.ts`).

## Capital broadside and guard posts

- **No guard post.** A broadside capital (`hasTurretFireControl`) circles its target at `fireRange × BROADSIDE_STANDOFF`. Within `BROADSIDE_RANGE_DEADBAND` (5 %) of that range it is AT its stand-off and holds the beam with no key held, so the hull rests and its pose stops going out. Lock: `tests/unit/capitalCombat.test.ts`.
- **With a post** (`setGuardPost(x, y, radius)`, server-only, radius ≥ `shipTuning(kind).guardRadiusMin` per #18) it fights FROM the post (`tickGuardBroadside`): a velocity controller holds it at rest inside `GUARD_HOLD_FRAC` of the radius and draws it back beyond that, beam to the target while inside `GUARD_RETURN_FRAC`. It never leaves the radius for range or to chase.
- All ratios are of the kind's own `maxSpeed` / radius; plain-field state (alloc-free, #14). Lock: `ai/HostileDroneBehaviour.guard.test.ts`.
- **Guard leash, every other ship (RTS Part B slice 5).** A non-broadside ship with a post keeps its normal combat flying; the post only filters its target pick: `pickTarget` is measured from the POST with `maxDistance = prevMaxDistance = guardR` (`_pickOptsGuard`), so it engages only inside the radius, lets a held target go once it leaves, and skips the uncapped out-of-sensor fallback. With nothing to fight it flies back to the post (`tickPatrol` → `tickMoveTo`, the move target first when one is set). `guardR` = `max(radius, shipTuning(kind).guardRadiusMin)` (a fighter at 2× scale: 1200), the same guard area the capital uses; no new constant. What it treats as hostile is unchanged (on-sight foes vs the retaliation ledger), so Aggressive engages anything hostile inside the radius and Defensive only hits back inside it. Applies to every brain with a post (owned ships via `holdHullAt`, Living World flagship escorts via `setBotGuardPost`). Lock: `ai/HostileDroneBehaviour.guardLeash.test.ts`.
- **A guard post can follow a ship (owner 2026-11-15, flagship escorts: "Leash, but the zone follows the flagship").** `setGuardPost(x, y, r, anchorId)` anchors the post to another swarm entity: at the top of every tick `followGuardAnchor` resolves the anchor through `view.resolveEntityInto` (the flocking seam, own scratch buffer, no allocation) and moves the post onto its live pose, so the target pick, the retaliation reach and the idle return are all measured round where the anchor IS. While the anchor can't be resolved the post holds its last known spot ((x, y) until the first resolve); when the anchor leaves the AI controller (`AiController.unregister` → `noteEntityGone` on every brain) the post is cleared. Without `anchorId` (or a later `setGuardPost` without one) the post is fixed. Broadside capitals honour an anchor too. General on purpose: the RTS Escort mode will anchor to a chosen ship. Locks: `ai/HostileDroneBehaviour.guardAnchor.test.ts`, `tests/integration/sectorRoom/flagshipEscortGuardFollow.test.ts`.

## Player-owned ships (players side)

An RTS owned ship is flown by this same brain, built with `new HostileDroneBehaviour(kind, { side: 'players', ownerId, energyPool })`. All options absent ⇒ a drone, byte-identical.

- **Side:** `side: 'players'` replaces the kind's NPC allegiance, so target claims and neighbour grouping use the players side, whatever the hull. Every pilot is friendly; a pilot is a target only through the retaliation ledger (`markHostile`), never the owner or the owner's other ships (the owner's fire is ignored).
- **Enemies:** a swarm ship whose allegiance attacks players on sight (`isOnSightHostile(its side, 'players')`, robots) is engaged within `ON_SIGHT_ENGAGE_RANGE`; drones (neutral to players) only on retaliation.
- **Never runs:** its role's morale weights become Fight on 1 / Fall back 0 / Flee 0, so every roll fights on.
- **Energy:** `energyPool` is the ship's one pool (`{ energy }`, a hull record fits as is); the brain regenerates and spends it exactly as it does its own drone pool. The brain is the pool's one regen owner: `SectorRoom.tickEnergy` does not also regenerate parked hulls (lock: `ownedShipsAiPilot.test.ts`).
- **Wiring (RTS Part B slices 2–3):** `AiController.register(id, slot, brain, { hull: true })`: the hull's keys reach the sink with its id (the sink's one hull branch posts them as pilot `INPUT`) and its `intent.fire` goes to the sink's `postHullFire` (the hull's trigger in the player fire pipeline, gated by the line-of-fire gate), never `handleAiFire`; self pose falls back to `lingeringPoseCache`. Detail: [fleet-command](fleet-command.md) §0.
- **Retaliation and morale (RTS Part B slice 4):** a hit on an owned hull calls `AiController.markHostile(hull, shooter's owner)` for the hull and every AI-flown squadmate of the same owner (`SectorRoom.ownedHullRetaliates`; the shooter goes through `hostileActorOf`, so one playerId covers that player's active ship and parked hulls), and `AiController.noteDamage` with the HULL the hit took (never shield damage). No fleet-side retaliation ledger. Lock: `tests/integration/sectorRoom/ownedShipsRetaliate.test.ts`.
- **Handling:** the kind passed in is used as is (`makePilotHandling`), so a pre-scaled kind (upgrades, `energyMax`) flows through.
- **Attitude (RTS Part B slice 6):** `setEngageOnSight(on)`, default on (drones and robots unchanged). On (Aggressive) it engages what it sees: the on-sight stance table, robots, and any swarm ship hostile to its OWNER (`view.hostileToPlayer(id, ownerId)`, which the room sets to its truce-aware `npcHostileTo`). Off (Defensive) it fights only its retaliation ledger.
- **Hold fire (RTS Part B slice 7):** `setHoldFire(on)`, default off, independent of `setEngageOnSight` (which keeps the attitude to return to). On, `tick` picks no target at all (no on-sight, no retaliation): no `intent.fire`, no chase, no turn toward an attacker; the ship flies its job (move target / guard post / hunt search / flock, or a Flee run). `markHostile` still records and `FORGET_TICKS` still decays the ledger, so lifting hold fire under Defensive answers an attacker that hit within the last 30 s; an older one is forgotten. Lock: `HostileDroneBehaviour.holdFire.test.ts`.
- **Hunt (RTS Part B slice 6):** `setHunt(true)` clears the guard post and move target and sights on-sight enemies out to the sensor range (not `ON_SIGHT_ENGAGE_RANGE`). With nothing to fight, `tickSearch` flies an expanding square (legs d, d, 2d, 2d, ... with d = 1.5 × sensor range, 90° left turns, first leg along the nose) round where the search began, each leg a plain `tickMoveTo`, waypoints clamped to 95 % of `SECTOR_PLAYABLE_HALF_EXTENT`; a fight restarts the square from where it ends. A guard post ends the hunt.
- **Attack order (RTS Part B slice 8):** `setOrderedTarget(id, tick)` (null lifts it). The target goes on the retaliation ledger and is never forgotten while ordered, so a Defensive ship fights even a neutral; lifting the order removes the order's mark unless the target hit the ship since. In the pick it carries `ORDERED_TARGET_PRIORITY` (4; with the structure `priorityBias` 3 its score is divided by 13): it beats a free enemy up to ~3.6× nearer, still wins with two squadmates' claims on it, and a fourth ship spreads (spread targets, dwell and stickiness unchanged, owner rule "priority, not an override"). While the target is a live candidate the pick is uncapped from the ship (no sensor cap) and the guard leash is lifted for it only (other targets still need to be inside the radius); a guarding broadside capital leaves its post for it. Post, move target and hunt are untouched, so the ship goes back to its job afterwards. Hold fire still wins. A re-key (owner takes / lets go of the target's controls) carries the sticky pick. Lock: `HostileDroneBehaviour.orderedTarget.test.ts`.
- **Travel (RTS Part B slice 9):** `setTravel(x, y)` (an owner's Move or Retreat) clears the guard post and the hunt and flies `tickMoveTo` at the full cruise; a leg longer than 3 × `guardRadiusMin` asks for the top speed with `boostOk`, and the virtual pilot's boost gate decides. The target pick runs as usual (locks, trigger), but the combat manoeuvres never run: `fireOnTheWay` holds the trigger only while the target is in range and already inside the aim cone (the same cone rules as `tickCombat`; no charge line to hold), and the ship never turns toward it. Arrived (inside `wingmanArrive`, below 3 % of max speed) it sets its guard post at the point (`getTravelState` ⇒ 2). A guard post, a hunt or `stopAt` (brake along the course, post at the halt spot) ends a travel. `getActivity()` reports the job for the fleet panel. Lock: `HostileDroneBehaviour.travel.test.ts`.
- **Patrol leg (RTS Part B slice 11):** `setPatrolLeg(fromX, fromY, x, y)` is a travel that fights: the pick is leashed to `guardRadiusMin` round the nearest point of the leg (`legLeashCentre`, the ship's own spot while on the route), and a target picked there gets `tickCombat`, not `fireOnTheWay`; with none it flies the leg on. A broadside capital stays on its travel (turrets fight). `getActivity()` ⇒ `patrolling` (attacking / chasing in a fight). The room steps the route (`core/ai/stepRoute.ts`, shared with `PatrolSubsystem`). Lock: `HostileDroneBehaviour.patrol.test.ts`.
- **Retaliation past the leash (slice 6):** a guarding ship with nothing inside its radius picks a LEDGER target out to guard radius + its fire range (`_pickOptsGuardRetaliate`), so a ship shot from just outside its area fires back from the edge, then goes back to its post. On-sight targets stay inside the radius.

Lock: `ai/HostileDroneBehaviour.ownedSide.test.ts`, `ai/HostileDroneBehaviour.hunt.test.ts`.

## Roles and the sensor-capped target pick

- Every ship kind carries `aiRole` (`scout|interceptor|fighter|gunship|missileBoat|capital|robot|civilian`), a catalogue data field, not on the wire.
- `ai/tactics/roleProfiles.ts` is the frozen per-role table the decision layer reads: sensor range, range band, aggression, reaction, aim error, manoeuvre and morale weights. Ranges are multiples of the ship's fire range, never absolutes (#18).
- `HostileDroneBehaviour` caps NEW body-target picks at `roleSensorRange(role, fireRange)` (floored at `ON_SIGHT_ENGAGE_RANGE`) via `pickTarget`'s `maxDistance`. The held target stays eligible at any range (`prevMaxDistance: Infinity`). When nothing is in sensors it falls back to the uncapped pick, so a director-ordered or retaliation contact (`markHostile`) across the sector is still hunted.
- Pick options are class-field scratch (alloc-free).

Locks: `ai/HostileDroneBehaviour.sensor.test.ts`, `ai/tactics/roleProfiles.test.ts`.

## Steering, flocking and formations

`src/core/ai/steering.ts`, `flocking.ts`, `formation.ts`. Scalar in, caller-owned out (alloc-free).

- **`steering.ts`:** pure `arrive` / `seek` (heading plus a thrust scale that ramps to 0 within a slow radius, so per-kind damping brakes the body to a stop).
- **`flocking.ts` (boids):** `addCohesion` (toward the leader, with an ARRIVAL ramp so the pull fades to 0 within `FLOCK_FOLLOW_DISTANCE`: "slow down once close"), `addAlignment` and `addSeparation` accumulate into a caller-owned `FlockAccumulator`; `resolveFlock` returns a unit direction and a thrust scale (capped at 1 = calm cruise, NO boost). The feel constants (`FLOCK_*`) are exported.
  - The non-combat roaming squads use it via `HostileDroneBehaviour.tickFlock`: a leader-led herd at cruise. The leader THROTTLES / WAITS so followers tighten (no boost), and squads spawn CLUSTERED so the herd is tight from birth. See `src/server/CLAUDE.md` "In-sector squad herding — leader + FLOCKING".
- **`formation.ts`:** wedge / line / column slot geometry (leader-frame rotation, ship-angle convention `(-sin θ, cos θ)`). Unused, kept for a future rigid-formation mode.

## Context steering

`src/core/ai/contextSteering.ts` (Fray's technique, Game AI Pro 2 ch. 18).

- Each agent owns `interest` and `danger` `Float32Array(CONTEXT_SLOTS = 16)` maps (`createContextMaps()`, ONCE per behaviour).
- Writers max-accumulate into them: `addInterestToward`, `addInterestOrbit`, `addDangerFromPoint`, `addDangerFromSegment` (ally fire lanes). A new concern = a new writer.
- `resolveContext(m, out)` masks slots above min danger + `CONTEXT_DANGER_EPSILON`, takes the best interest slot with parabolic sub-slot refinement (masked neighbours count as 0, so it only leans toward safe slots), and returns a heading plus `speedScale` (0 when every slot is fully dangerous).
- **Why not weighted sums:** summed boids vectors cancel (an obstacle dead ahead of the goal gives a zero vector) and jitter.
- Slot `i` = ship angle `i·2π/16`, forward `(-sin θ, cos θ)`; `angleForDir` = `atan2(-dx, dy)`.
- Alloc-free (#14); callers pass size-dependent radii and lane widths from `shipTuning` (#18).

Lock: `contextSteering.test.ts`; bench `benchmarks/ai-context-steering.bench.ts`.

## History

- **2026-06-18:** flocking added (`flocking.ts`); formation slots became unused.
- **2026-11-11:** capital broadside guard posts (owner decision). The stand-off deadband was added after a sub-1 u/s creep at the stand-off cost the capital-duel perf scene 3 KB/s of swarm wire (PR #549).
- **2026-11-13:** AI overhaul slice 3 added roles and the sensor-capped pick; `ai.turnKp` / `ai.maxTorque` were removed (nothing read them). Context steering landed, not yet wired into a behaviour at the time.
- **2026-11-13:** the virtual pilot (owner rule, plan composed-harbor §0) replaced AI-only actuation.
