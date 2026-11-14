# AI pilots: how NPC ships fly

How the AI brain in `src/core/ai/` turns decisions into flight. Which sides fight whom is in [allegiances.md](allegiances.md); how the client stays in step is in [ai-lockstep.md](ai-lockstep.md). The rules are in [src/core/CLAUDE.md](../../src/core/CLAUDE.md#what-belongs-in-srccore).

## The virtual pilot: a player's controls only

An NPC brain never emits an impulse or an angvel snap. It picks a FACING and a WANTED VELOCITY, and `ai/virtualPilot.ts` (`pilotInputs`, pure, alloc-free, caller-owned `PilotState`) turns them into the keys a player would press (thrust, reverse, turn left/right, boost) as `AiIntent.input` bits. The worker runs them through `applyShipInput` with the NPC's own kind.

- **Handling comes from the kind:** `makePilotHandling(kind, massOf(kind, NPC_MASS_FALLBACK))`.
  - Snap turns stop on release.
  - Torque (capital) turns stop early on the predicted coast `ω/angularDamping`, and counter-turn when even that overshoots.
  - Throttle is bang-bang on the velocity error along the nose (reverse brakes).
  - `brakingSpeed(h, dist)` is the arrive ramp.
- **`leadTicks: 1`** predicts the pose one tick on (the server brain reads the last worker step).
- **Boost is energy-gated per NPC** with the shared `Energy.ts` helpers (`BOOST_TICK_COST`, the kind's `energyMax` / `energyRegenRate`; server-only state).
- **Every mode flies this way:** `HostileDroneBehaviour` uses it for combat, broadside, guard, patrol, move-to and flock. Its decisions (targets, ranges, fire gate) are unchanged.
- **Pace:** out of combat it chooses `CALM_CRUISE_FRAC` (0.45) of its cruise speed (the pace the retired `ai.thrust` gave); in combat it has full handling and boost.
- **Difficulty** knobs are the pilot's reaction latch and aim, never weaker engines.

Locks: `ai/virtualPilot.test.ts` (real Rapier body, fighter and capital, with and without a tick of lag) and the `HostileDroneBehaviour*.test.ts` suites (keys via `ai/pilotTestKit.ts`).

## Capital broadside and guard posts

- **No guard post.** A broadside capital (`hasTurretFireControl`) circles its target at `fireRange × BROADSIDE_STANDOFF`. Within `BROADSIDE_RANGE_DEADBAND` (5 %) of that range it is AT its stand-off and holds the beam with no key held, so the hull rests and its pose stops going out. Lock: `tests/unit/capitalCombat.test.ts`.
- **With a post** (`setGuardPost(x, y, radius)`, server-only, radius ≥ `shipTuning(kind).guardRadiusMin` per #18) it fights FROM the post (`tickGuardBroadside`): a velocity controller holds it at rest inside `GUARD_HOLD_FRAC` of the radius and draws it back beyond that, beam to the target while inside `GUARD_RETURN_FRAC`. It never leaves the radius for range or to chase.
- All ratios are of the kind's own `maxSpeed` / radius; plain-field state (alloc-free, #14). Lock: `ai/HostileDroneBehaviour.guard.test.ts`.

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
