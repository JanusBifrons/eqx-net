# Living World — bot population, hunting & inter-sector warp

> Status: shipped 2026-05-16. Code: `src/server/livingworld/`,
> `SectorRoom` Living-World hooks, `ColyseusClient` `bot_aggro` handler,
> `galaxy.ts` `AMBIENT_DRONE_FLOOR`. Plan:
> `.claude/plans/i-d-like-you-to-transient-brooks.md`.

## The problem

The 7-sector galaxy ticked when empty (drones patrolled, asteroids
drifted) but the drones were **static per-sector furniture**: each
`SectorRoom` seeded 8–20 patrol drones that never left their sector,
never respawned after a combat kill, and only fought a player who shot
them first (`HostileDroneBehaviour` flips to `COMBAT` only on
`markHostile`). Nothing pursued you; nothing came from elsewhere; killing
everything in a sector left it permanently dead. The world was alive in
the way a diorama is.

## What shipped

A process-global **`LivingWorldDirector`** owns a fixed pool of **25
hunter bots** that:

- **warp between sectors toward players** — with players online, the
  whole population converges (proportional to per-sector player count,
  min-pack floored) on player-occupied sectors; with nobody online they
  spread evenly across all 7 so the empty galaxy stays uniformly alive;
- **proactively hunt on sight** — a bot in a sector with players is made
  hostile to them, so the *existing* `COMBAT` branch pursues + fires
  (no new AI behaviour);
- **respawn "from outside known space"** — a combat-killed bot warps back
  in after a ~12 s dramatic delay at a random sector's edge, heading
  inward; the total returns to 25;
- **cooperate with TiDi** — under load the `LoadShedder` may evict bots;
  the director pauses and only refills once sheds stop (it never fights
  the shedder).

Each galaxy sector also keeps a small **ambient patrol floor**
(`AMBIENT_DRONE_FLOOR = 2`, the legacy non-proactive `drone-*` drones) so
a not-yet-visited sector isn't lifeless before the hunters route in. The
hunters (`lwbot-*`) are additive to that floor.

## Architecture

```
index.ts main() ── after the eager matchMaker.createRoom(galaxy-*) loop
  └─ new LivingWorldDirector(roomsBySectorKey).start()
        │  unref'd ~1.5 s control loop  +  per-room bus subscriptions
        ├─ population.ts        pure: distribution / migration / rng / graph-hop
        ├─ BotTransitController  pure TransitStateMachine, per in-flight bot
        └─ SectorRoom hooks      spawn/despawn/markBotHostile/playerCount/hasFreeSlot
```

Single process, direct room references. The director is the **single
owner of bot lifecycle**; the bot record state machine
(`active → in-transit → active`, or `→ respawning → active`) is *guarded
and idempotent* so the overlapping signals (killed-while-in-transit,
shed-then-killed, emergency-respawn-vs-transit-outcome) converge instead
of racing — a lifecycle bus event always wins over a transit outcome.

### Four load-bearing design decisions (and why)

1. **Hybrid transit, server-internal hop.** Bots reuse the *pure*
   `TransitStateMachine` (same 30 s vulnerable spool, cancel-on-death,
   `TRANSIT_STATE_CHANGED` emits) and the *existing* `warp_out`/`warp_in`
   broadcasts players already see — but the cross-room move is a director
   callback, NOT the player path. `reserveSeatFor` / `onJoin` / Limbo are
   WebSocket-client-only; **bots are not Colyseus clients**, so they
   physically cannot thread that path. `TransitOrchestrator.ts` is
   *consumed-from* (the pure machine) but never modified — the in-flight
   Phase G transit work is untouched.

2. **Hunt via the existing `markHostile` channel — no new AI, no wire
   bump.** The client constructs and ticks its *own* `AiController` +
   `HostileDroneBehaviour` for in-interest drones (`ColyseusClient.ts`;
   `src/client/CLAUDE.md` "Drone prediction is reconciled"). A
   server-only "proactive" behaviour would diverge from that prediction
   and snap every snapshot — the exact chapter-2 dual-path failure
   `feel-test-lockstep.spec.ts` locks. A hunter is just *a drone hostile
   to a player it wasn't shot by*: the director calls the existing
   `SectorRoom`/`AiController` `markHostile` AND broadcasts one discrete
   `bot_aggro` the client feeds into its own `_aiController.markHostile`
   — the precise server→client twin of the proven `damage`→`markHostile`
   mirror. Zero `HostileDroneBehaviour` change, zero `SWARM_WIRE_VERSION`
   bump. Re-sent each control tick so the 30 s hostility decay never
   trips while a player is present; a dropped packet self-heals next
   tick.

3. **Atomic handoff with a self-heal.** `BotTransitController.commit`
   pre-checks the destination's free slot *before* despawning the source,
   so a transit can't lose a bot to slot exhaustion (it cleanly cancels
   the spool and the bot stays put for the director to retry). The one
   true race (slot taken between pre-check and spawn) is self-healed: the
   bot is scheduled for a no-origin respawn so the population always
   reconverges to 25.

4. **Quiet despawn ≠ kill.** Inter-sector despawn reuses the
   LoadShedder's proven `evictSwarmEntity{broadcast:false,
   emitDestroyed:false}` — critically NO `ENTITY_DESTROYED` (that bus
   event is the director's *respawn* trigger; a transit must not look
   like a death) and no `destroy` kill-feed.

### Distribution math (pure, `population.ts`)

`computeDesiredDistribution` — players present ⇒ largest-remainder
proportional to player count with a `MIN_PACK_PER_OCCUPIED` floor;
zero players ⇒ even split across all sectors. `planMigrations` — bounded
greedy surplus→deficit, one galaxy-graph hop per pass (`nextHopToward`
BFS), `|Δ|≥1` hysteresis, and a `frozen` set so arrival-cooldown bots
count toward occupancy but are never re-tasked (kills the over-migration
flap). RNG is an injected seam (`Math.random` in prod, seeded in tests).

**Occupancy hysteresis — the director damps the *input*, not the math.**
`computeDesiredDistribution` is stateless and correct per call, but its
players-present⇒funnel / zero-players⇒even-spread switch is a *cliff*:
one control tick reading `playerCount()===0` flips the whole desired map
and `planMigrations` immediately streams `maxMigrationsPerTick` bots out
of the (now "empty") player sector. A mobile client's connection flap
drops the count to 0 for several seconds (`onLeave` → lingering hull,
`isActive=false`), so the pack mass-evacuates then mass-re-funnels on
reconnect — each leg a periodic warp burst the player feels as
consistent "bumps" that worsen with bot count. The director therefore
records, per sector, the wall-clock it last saw a live player and feeds
`computeDesiredDistribution` a *sticky* count: occupied if a player is
there now **or** was within `playerStickyMs` (default 30 s). The pure
math is unchanged; only the signal into it is debounced — the same
anti-flap philosophy as `arrivalCooldownMs`/`shedRecoveryMs`, on the
occupancy axis. Hostility (`markBotHostile`) still keys off the **live**
count, so hunters stand down the moment a player genuinely leaves; only
placement is held. Diagnosed from `diag/captures/2026-05-16…q272do`
(clean network, rtt 0 — the churn was *not* the mobile link the first
capture implied; the population timeline showed the same bot IDs
cycling sol-prime↔neighbours on the rigid control cadence). Regression
lock: `livingWorldDirector.test.ts` → "does NOT evacuate the pack when
the player connection briefly flaps".

## Instrumentation & observability

- `GET /dev/population` (NODE_ENV-gated, mirrors `/dev/limbo`): live
  `{ total, active, inTransit, respawning, perSector:{players,bots} }`.
- `serverLogEvent` tags routed to a new **`population`** diag bucket:
  `bot_spawn`, `bot_despawn`, `bot_transit_start|commit|cancel`,
  `bot_respawn`, and a per-tick `population_report` (the primary
  debugging stream). Discrete `BOT_SPAWNED`/`BOT_DESPAWNED`/
  `BOT_TRANSIT_STARTED` bus variants + the reused `TRANSIT_STATE_CHANGED`
  give telemetry/Pino subscribers the lifecycle for free.

## Testing layers

| Concern | Level | Lock |
|---|---|---|
| distribution / migration / hysteresis / respawn-sector / edge-pose | pure unit | `population.test.ts` (seeded RNG) |
| spool→commit→handoff, kill-mid-spool, commit-fail | pure unit | `BotTransitController.test.ts` (fake timers) |
| SectorRoom hooks across the real WS (spawn→warp_in, aggro→bot_aggro, quiet handoff) | integration | `livingWorldHooks.test.ts` |
| cross-sector converge / funnel-to-player / no-origin respawn / shed-pause-then-refill | integration (multi-room harness) | `livingWorldDirector.test.ts` |
| player-visible end-to-end convergence | E2E | `living-world.spec.ts` (outcome-gated) |
| drone AI lockstep not regressed by the new aggro path | E2E | `feel-test-lockstep.spec.ts` |

The deterministic lifecycle edge cases live at the integration level on
purpose — that's where those bugs live and where they run fast and
deterministic; the E2E covers only the player-facing essence and is
strictly outcome-gated so a slow env never flakes it.

## Drone warp-in (2026-06-11, plan `goofy-wobbling-brooks` / playtest Issue 12)

The complaint: drones spawned by default in Sol — *"they should never just
magically appear; they should enter at leaf sectors and take ~5 min of warping
to reach Sol."* The fix made the director a **roaming population that only ever
enters the galaxy from the edge**:

- **Entry-only ingress (the headline invariant).** Every *from-nowhere*
  materialisation — the initial seed AND every combat respawn (`respawnStep`) —
  happens ONLY at an **entry (edge) sector** (`getEntrySectors()` = the outermost
  hex ring; `pickEntrySector`/`liveEntrySectors` in `population.ts`, intersected
  with the director's live rooms + a single-interior fallback so a test harness
  can't deadlock). A combat respawn during an interior attack therefore warps in
  at the edge and *travels back* — it does NOT pop into the base. Hop *arrivals*
  (`bot_transit_commit`) may land anywhere; they're graph traversal, not ingress.
  The regression lock asserts **every `bot_spawn` sectorKey ∈ entry set / never
  `sol-prime`**.
- **Hop-by-hop traversal with emergent travel time.** The old "one warp = land
  on the target" is gone. `advanceMembersTowardGoal` warps each non-at-goal
  member ONE `nextHopToward(rec.sectorKey, goal)` hop, re-issued every control
  tick from BOTH the `warp` and `attack` branches (stragglers + edge-respawned
  reinforcements keep flowing in independently — the squad's position is just the
  multiset of member `rec.sectorKey`, no squad-level "current" field). Each hop
  costs an **invulnerable `hopTravelMs` flight** (default 120 s, env
  `EQX_BOT_HOP_MS`): `HunterBotWarpController.doHop` was split into `depart`
  (despawn source + stash carry + arm a per-bot arrival timer) and `arrive`
  (spawn at dest edge + slot-race self-heal + `markActive`). The bot is fully
  despawned mid-flight, so the window is invulnerable *by construction*; timers
  are cleared by `disposePending()` on `stop()`. Travel time is emergent — a base
  two hops in takes ~2× a one-hop base. (A goal that's a live room *outside* the
  graph — a synthetic test/engineering sector — gets a single direct hop, still a
  despawn→spawn pair.)
- **Roaming replaces the ambient floor.** Idle, unassigned squads slow-drift the
  graph: `roamStep` picks a random live neighbour (`pickRoamGoal`) every
  `roamIntervalMs` (default 45 s) once gathered, then advances members toward it.
  Roaming squads stay **NEUTRAL** — hostility is marked ONLY in the `attack`
  branch — so a pack drifting through a base-less player's sector does not hunt
  them. This is why `AMBIENT_DRONE_FLOOR` could retire to 0.
- **One squad per ~5 min per base.** `WaveDirector.plan(nowMs)` rate-caps
  assignment to ≤1 dispatch per `dispatchIntervalMs` (default 5 min) per ready
  faction (first immediate, then capped). The dispatched squad still traverses
  hop-by-hop from wherever it is, so its arrival is further delayed by travel;
  coincidental multi-squad convergence is accepted.
- **Boot-seeding + drone persistence retired.** `AMBIENT_DRONE_FLOOR = 0` →
  galaxy rooms boot `droneCount: 0`. `SectorPersistence` no longer persists drone
  (kind 1) rows (they're transient — re-seed at entry on boot); `CURRENT_SCHEMA_-
  VERSION` 1→2 reseeds cleanly. The persistence system is otherwise unchanged
  (asteroids/structures/roster/Limbo persist as before).
- The `warp_warning` banner now fires once per squad on the first FINAL approach
  (`squad.warned`), `countdownMs = spoolMs + hopTravelMs`. **(Superseded — see
  "Incoming-warp feed" below.)**

Locks: `population.test.ts` (entry + roam pickers), `WaveDirector.test.ts`
(dispatch cadence), `livingWorldDirector.test.ts` (entry-ingress invariant; idle
squad roams inward via a hop staying neutral; base-less player never triggers
`warping`/`attacking`). E2E `wave-attack.spec.ts` was updated for the entry route
(`EQX_BOT_HOP_MS=500`); the netgate still applies (population churn touches the
swarm broadcast).

## Incoming-warp feed (2026-06-13, Phase-4 P0)

The "sector incoming" HUD banner read **"Nothing incoming"** even while ships
warped into the player's sector (user's 3rd failed-fix report; diagnostic
`2026-06-13T15-48-18Z-84rbl1` captured 8 remote `warp_in` arrivals and zero
warnings). The cause was structural: the ONLY `warp_warning` broadcast lived in
the wave step's final-approach branch (`finalApproach > 0 && !squad.warned`), so a
roaming squad, a lone fighter, or a player never produced one.

The fix moves the trigger off the wave special case onto the **single universal
cross-sector hop choke point** — `startSquadMemberTransit` — which every hop
(wave, attack-straggler, and roam) already funnels through. At the decision
instant it registers the departing squad as inbound to its next-hop sector in the
new **`IncomingRegistry`** (`src/server/livingworld/IncomingRegistry.ts`, owned by
the director — the only object spanning every galaxy room). The registry:

- broadcasts `warp_warning` to the destination room (deduped: 8 members departing
  for the same sector in one tick → ONE banner; a re-tasked squad's old
  destination is cleared so the banner follows the ship);
- broadcasts `warp_warning_clear` on arrival (a `reconcileIncoming()` sweep at the
  `tick()` tail — squad gathered / no member still inbound) or on retreat;
- colours each inbound by `disposition`: a wave (`targetFactionId !== null`) is
  `enemy` (red), an idle/roaming pack is `neutral` (amber), a player is `friendly`
  (green). The wire field is optional (`WarpWarningSchema.disposition`); the client
  maps `enemy → 'hostile'`.

Inbound **players** feed the same registry through a cycle-safe singleton
(`incomingPlayerSink.ts`, `set/getIncomingPlayerSink` — the `getLimboStore`
pattern): `TransitOrchestrator.beginTransit` registers a friendly inbound,
`cancelTransit` and the destination room's `client_ready` (`handleClientReady`)
clear it. A null sink (Living World disabled / test harness) simply means no
player banner.

Why it won't fail a 4th time: there is no second "did we remember to warn for this
departure kind?" surface left — the warning is co-located with the one
"I am leaving for another sector" event. Locks: `IncomingRegistry.test.ts`,
`tests/integration/sectorRoom/incomingWarp.test.ts` (the headline roamer
regression — must fail pre-fix), `wave-attack.spec.ts` (now asserts the red
`data-warning-relation="hostile"`). Netgate applies (the broadcast is live-loop).

## In-sector squad formation (Phase 5 WS-4)

Roaming squads no longer have each drone orbit the origin independently
(the "they just sort of sit there menacingly" complaint). A gathered, IDLE,
unassigned squad **flies in formation** toward arbitrary in-sector A→B
destinations:

- `LivingWorldDirector.formationStep()` (each control tick, after `roamStep`)
  designates a **leader** (first active member in `botIds` order), picks/refreshes
  a random in-sector destination, and assigns each follower a **wedge slot**
  rotated into the leader's live pose frame (so the wedge faces the travel
  direction).
- Targets reach the drones via two new `LivingWorldRoom` hooks —
  `getBotPose(botId)` (SAB pose, for the leader) and `setBotMoveTarget(botId,x,y)`
  (→ the drone's `HostileDroneBehaviour.setMoveTarget`).
- The drone's IDLE behaviour flies to its target with the pure `arrive`
  (`src/core/ai/steering.ts`): full thrust far out, ramping to 0 within
  `MOVE_ARRIVE_SLOW_RADIUS` so per-kind `linearDamping` brakes it to a STOP at the
  slot — the "slow down and come to a stop, don't float past" feel. The slot
  geometry is the pure `formation.ts` (wedge/line/column).
- The move target is the optional, **server-only** `IAiBehaviour.setMoveTarget`
  seam (the client never ticks the drone brain → no lockstep surface, no wire
  bump). COMBAT overrides it: a waved/hostile drone pursues normally.

Because a formation-flying squad stays clustered, it **gathers + spools + warps
between sectors as one unit** — the roam hop only fires once gathered, and
`advanceMembersTowardGoal` starts every member's transit in the same control
tick. The formation tunables (`FORMATION_DEST_RANGE/ARRIVE/SPACING`,
`MOVE_ARRIVE_SLOW_RADIUS`) are a FEEL knob — confirm on-device. Locks:
`steering.test.ts`, `formation.test.ts`, `HostileDroneBehaviour.moveTarget.test.ts`,
`tests/integration/sectorRoom/livingWorldFormation.test.ts`.

## Director-state persistence (Phase 5 — "restart from any state")

The user's directive was that the director should "pick up and restart from any
state" — when the server reboots, review the squads it has and resume, not start
the galaxy from a blank slate. Half of this shipped earlier (the `WaveDirector`
dispatches the NEAREST roaming squad to a ready base); this is the other half:
**the director survives a server restart.**

Because drones are director-owned (NOT in the per-sector snapshot — persisting
them there would orphan them from the director), the director persists its OWN
**abstract squad continuity** on its own lane (see
[persistence-and-migrations.md](persistence-and-migrations.md) "Director-state
lane"):

- per squad: `{squadId, kind, sectorKey, targetFactionId, state}`;
- the `WaveDirector`'s `waveCount` + `lastDispatchAtMs` bookkeeping.

`LivingWorldDirector.persistState()` writes it (graceful shutdown + a throttled
60 s control-loop heartbeat for crash defence — both off the 60 Hz live loop).
`restoreFromPersistence()` reads it once inside `start()`, AFTER the fresh seed:
`SquadPool.restoreStates` + `WaveDirector.restore` overlay the persisted state,
then the **existing** machinery does the rest — `respawnStep` re-spawns each
squad's bots at its restored `sectorKey` (entry sector → direct; interior →
edge-ingress + hop-traverse, so the entry-only-ingress invariant holds), and the
next `waveDirector.plan` RESUMES an in-progress wave or cleanly de-escalates per
LIVE readiness (a base that lost its miners during downtime stands the squad down
for free).

**What is deliberately abstract (and why):** individual bot poses and in-flight
`BotTransitController` warps are NOT serialized — a mid-flight hop simply resets to
the squad's sector on restart. Persisting exact bot poses was rejected as
director-orphaning and not trivially serializable for in-flight transits. The
fixed 24-bot pool is always re-seeded; only squad ASSIGNMENTS carry over. A
`DIRECTOR_STATE_VERSION` bump (or any unknown squad id) discards the row for a
clean reseed.

Locks: `DirectorPersistence.test.ts` (round-trip + version/staleness/corrupt →
fresh seed), `SquadPool`/`WaveDirector.test.ts` (serialize/restore, incl. the
rate-cap surviving a restart), and
`tests/integration/sectorRoom/livingWorldDirectorPersistence.test.ts` — a
two-boot *faithful* restart (boot #1 roams a squad into the interior + persists;
boot #2 brings up fresh rooms with roaming OFF and the squad resumes at the
interior, which only the restore can produce — verified against a no-row
fresh-seed control arm).

## Future work

- Per-kind hunter loadouts / threat tiers (extend the director's kind
  pick + `MountTargetView`, not the call sites).
- Multi-VM (Phase 9): the single-process direct-reference model becomes a
  Redis-coordinated director; the pure `population.ts` is unaffected.
- Difficulty scaling: `LIVING_WORLD_BOT_COUNT` and the control timings
  are already constructor options — wire them to a server-side config.
