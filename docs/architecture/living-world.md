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

## WS-E Phase-3 fixes (2026-06-20, plan `magical-summit`)

Four playtest-reported AI/lifecycle bugs, each with a fail-first lock:

- **#15 hostile drones render neutral on arrival.** Disposition rides the
  discrete `bot_aggro` broadcast fired by `markBotHostileToFaction`, which
  early-returns `if (!rec)`. The dominant race is the warp `arrive` path:
  `HunterBotWarpController.arrive` spawns the member on a macrotask AFTER the
  control tick whose `executeWaveStep('attack')` already pulsed
  `markSquadHostileToFaction` — so the arriving record didn't exist yet, leaving
  it neutral until the next ~1.5 s pulse. **Fix:** `spawnBot` /
  `spawnLivingWorldBot` take an optional `hostileToFaction { playerId,
  structureIds }` and mark hostility INLINE post-spawn; the director resolves it
  from `squadPool.squadOf(botId)?.targetFactionId` + the destination room's new
  `factionHostility()` resolver (the same `FactionLedger.membersOf` source
  `markSquadHostileToFaction` uses), in BOTH spawn paths (`respawnStep` +
  `arrive`), ONLY when the member lands AT its squad's target (base) sector.
  Locks: `LivingWorldBotHooks.test.ts`, `HunterBotWarpController.test.ts`.

- **#13/#19 attackers stack at one edge.** `BotCarry` carried vx/vy/angle/angvel
  but NOT x/y, so `arrive` always snapped to one clustered edge anchor. **Fix:**
  add `x,y` to `BotCarry` (captured from the live SAB pose in `despawnBot`); a
  WAVE hop now arrives at the carry pose CLAMPED via `clampToSectorBounds` (the
  same defense-in-depth the player `TransitOrchestrator.commitTransit` uses), via
  an injected `arrivalPoseFor` resolver; a ROAM hop returns null ⇒ the EDGE spawn
  (preserving the 2026-06-19 "roamers enter from the edge, never pop in on top of
  a player at the centre" invariant). Lock: `HunterBotWarpController.test.ts`.

- **#8 waves too frequent — retreat-reason tagging.** The time-box → retreat
  (`waveMaxAttackMs`) already lands a wave back to a discrete phase, but a 12 h
  audit couldn't tell a healthy time-box phase-end from a perpetual grind because
  the retreat carried no reason. **Fix:** `WaveDirector.buildContext` computes the
  cause (`base-razed` > `de-escalation` > `timeout` precedence) and threads it
  onto the retreat `WaveStep`; `executeWaveStep` passes it into the
  `wave_repelled` audit event (new optional `reason` field) + the
  `wave_deescalated` serverLogEvent, surfaced by both audit formatters. The
  "don't reset `lastDispatchAtMs` on a re-tasked squad" rule is already satisfied
  (faction-keyed, set only on a fresh commit). Lock: `WaveDirector.test.ts`.

- **#22 roaming avoids active-combat sectors.** `pickRoamGoal` was combat-blind.
  **Fix:** it gains an optional `avoidCombat(sectorKey)` predicate that drops
  flagged live neighbours (HOLDS at `from` when every neighbour is in combat);
  `LivingWorldDirector.roamStep` builds it from each room's `recentCombat()`
  (non-null ⇒ combat within the ~5-min sliding window) and audit-logs a re-route
  (`roam_avoid_combat`). Locks: `population.test.ts`, `roamAvoidCombat.test.ts`.

- **#9 roaming squads don't scatter (regression lock).** The anti-scatter
  mechanism — leader-led flocking + spawn-clustering + the 6-min roam dwell — was
  already in place; `roamRegather.test.ts` adds the explicit lock that the
  director KEEPS assigning flock roles (leader course + followers) to a roaming
  squad post-hop, so a future regression that bypasses `flockStep` for roamers
  fails loudly.

## Future work

- Per-kind hunter loadouts / threat tiers (extend the director's kind
  pick + `MountTargetView`, not the call sites).
- Multi-VM (Phase 9): the single-process direct-reference model becomes a
  Redis-coordinated director; the pure `population.ts` is unaffected.
- Difficulty scaling: `LIVING_WORLD_BOT_COUNT` and the control timings
  are already constructor options — wire them to a server-side config.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Living World Director (2026-05-16)**: process-global `LivingWorldDirector` ([src/server/livingworld/](../../src/server/livingworld)) owns a fixed pool of `LIVING_WORLD_BOT_COUNT = 25` hunter bots (`lwbot-*`), constructed in [index.ts](../../src/server/index.ts) `main()` AFTER the eager `matchMaker.createRoom(galaxy-*)` loop (it captures those `SectorRoom` instances) and `stop()`'d in `shutdown()` alongside the Limbo prune timer. unref'd ~1.5 s control loop (population/routing is discrete low-frequency logic — NOT a physics-tick concern). Defaults: `controlIntervalMs 1500`, `respawnDelayMs 12_000`, `arrivalCooldownMs 5_000`, `maxMigrationsPerTick 4`, `shedRecoveryMs 10_000`, `initialStaggerMs 200`, `playerStickyMs 30_000`, `spoolMs = SPOOL_DURATION_MS` — all constructor options (tests inject tiny values + a seeded RNG). **Occupancy hysteresis (`playerStickyMs`, diag 2026-05-16 `q272do`):** a sector that had a live player within the window still counts as occupied when the director builds the `playerCounts` it feeds `computeDesiredDistribution`, so a mobile client's disconnect→reconnect flap (which drops `playerCount()` to 0 for a few seconds — lingering hull is `isActive=false`) can NOT whipsaw the desired distribution between "all bots to the player" and "even 7-way spread" and mass-churn the whole pack through the player's sector every ~1.5 s control tick (the periodic warp "bumps" the player felt). Mirrors the `arrivalCooldownMs`/`shedRecoveryMs` anti-flap philosophy on the occupancy axis. The step-3 hostility check still reads the **live** `playerCount()`, so bots stand down the instant a player truly leaves — only bot *placement* is damped. Single owner of bot lifecycle; the `BotRecord` state machine (`active`/`in-transit`/`respawning`) is guarded + idempotent so kill/shed/emergency/transit-outcome signals converge, never race (a lifecycle bus event wins over a transit outcome). Bots are server-internal swarm entities (NOT Colyseus clients) — the cross-room hop is a `BotTransitController` (the *pure* `TransitStateMachine`, NOT a `TransitOrchestrator` fork) + the thin `SectorRoom` hooks `spawnLivingWorldBot` / `despawnLivingWorldBot` / `markBotHostile` / `playerCount` / `hasFreeSlot` / `eventBus`. Quiet inter-sector despawn reuses the LoadShedder path `evictSwarmEntity{broadcast:false,emitDestroyed:false}` — it MUST NOT emit `ENTITY_DESTROYED` (that bus event is the director's respawn trigger). Hunting is the *existing* `markHostile` channel + one discrete `bot_aggro` broadcast (server→client twin of the `damage`→`markHostile` mirror) — **do NOT add a `proactive` `HostileDroneBehaviour` branch or a swarm-wire flag** (see `src/core/CLAUDE.md` AI-lockstep section + [docs/architecture/living-world.md](living-world.md)). Ambient patrol floor is `AMBIENT_DRONE_FLOOR = 2` per galaxy sector ([src/core/galaxy/galaxy.ts](../../src/core/galaxy/galaxy.ts)); the 25 hunters are additive. Observability: `GET /dev/population` (NODE_ENV-gated) + the new `population` diag bucket (`bot_spawn`/`bot_despawn`/`bot_transit_start|commit|cancel`/`bot_respawn`/`population_report`). Locks: `population.test.ts`, `BotTransitController.test.ts`, `tests/integration/sectorRoom/livingWorldHooks.test.ts` + `livingWorldDirector.test.ts` (multi-sector harness `bootLivingWorldTestServer`), `tests/e2e/living-world.spec.ts` (since retired, superseded by the wave model). **Ops kill-switch (`EQX_DISABLE_LIVING_WORLD`, 2026-06-07):** when set to `1`/`true`, `main()` skips constructing + starting the director entirely (`isLivingWorldDisabled()` in [LivingWorldDirector.ts](../../src/server/livingworld/LivingWorldDirector.ts)), so no hunter bots spawn, migrate, or aggro — building/playtest gameplay is peaceful. The `AMBIENT_DRONE_FLOOR = 2`/sector patrol drones STILL spawn (they're per-sector swarm, not director-owned) but stay NEUTRAL until shot (reactive `damage → markHostile` only). `livingWorldDirector` stays `null`; every reference is null-guarded (`/dev/population` ternary, `shutdown()` optional-chain). Read once at boot — unset + restart to re-arm. Locked by `LivingWorldDirector.killswitch.test.ts`.

- **Drone warp-in refactor (2026-06-11, plan `goofy-wobbling-brooks` / playtest Issue 12)**: drones no longer materialise in interior sectors out of nowhere. **(1) Entry-only ingress (the headline invariant):** every from-nowhere spawn — initial seed AND combat respawn (`respawnStep`) — happens ONLY at a galaxy ENTRY (edge) sector (`getEntrySectors()` in [core/galaxy/galaxy.ts](../../src/core/galaxy/galaxy.ts) = the outermost hex ring; `pickEntrySector`/`liveEntrySectors` in [livingworld/population.ts](../../src/server/livingworld/population.ts), intersected with the director's LIVE rooms + a single-interior fallback). Hop *arrivals* (`bot_transit_commit`) may land anywhere — they're graph traversal, despawn→spawn pairs, not ingress. Squads home at entry sectors (`start()`). **(2) Hop-by-hop traversal:** the instant one-warp-to-target is gone — `advanceMembersTowardGoal` warps each non-at-goal member ONE `nextHopToward(rec.sectorKey, goal)` hop, re-issued every control tick from BOTH the `warp` and `attack` branches (so stragglers + edge-respawned reinforcements keep flowing in). The per-hop flight is `hopTravelMs` (**default 0 since Equinox Phase 8 — see below**; env `EQX_BOT_HOP_MS`), implemented in [director/HunterBotWarpController.ts](../../src/server/livingworld/director/HunterBotWarpController.ts) by SPLITTING the hop into `depart` (despawn source + stash carry + arm a per-bot arrival timer) and `arrive` (spawn at dest edge + slot-race self-heal + `markActive`); with the default 0 the arrival fires one macrotask later (atomic hop, no invisible window — see the Phase 8 note); a non-zero value re-creates the despawned mid-flight window. Timers are cleared by `disposePending()` on `stop()`. A goal that's a LIVE room outside the galaxy graph (a synthetic test/engineering sector) gets a single DIRECT hop (still despawn→spawn, not ingress). **(3) Roaming:** idle+unassigned squads slow-drift the graph — `roamStep` picks a random LIVE neighbour (`pickRoamGoal`) every `roamIntervalMs` (default 45s) once gathered, staying NEUTRAL (hostility is marked ONLY in the `attack` branch); this replaces the retired ambient patrol floor. **(4) Dispatch cadence:** `WaveDirector.plan(nowMs)` rate-caps assignment to ≤1 squad per `dispatchIntervalMs` (default 5 min, `DEFAULT_DISPATCH_INTERVAL_MS`) per ready faction (first immediate, then capped; the squad still traverses hop-by-hop so arrival is further delayed by travel). **(5) Boot-seeding retired:** `AMBIENT_DRONE_FLOOR = 0` → galaxy rooms boot `droneCount: 0` (the roaming pool provides all ambient presence); `SectorPersistence` no longer persists drone (kind 1) rows (transient/roaming — re-seed at entry on boot); `CURRENT_SCHEMA_VERSION` bumped 1→2 (clean reseed; the persistence SYSTEM is otherwise unchanged — asteroids/structures/roster/Limbo persist as before). The `warp_warning` banner is now deduped to one per squad on first FINAL approach (`squad.warned`), `countdownMs = spoolMs + hopTravelMs`. New director options: `hopTravelMs`/`roamIntervalMs`/`dispatchIntervalMs`. Locks: `population.test.ts` (entry/roam pickers), `WaveDirector.test.ts` (cadence), the rewritten `livingWorldDirector.test.ts` (every `bot_spawn` ∈ entry set / never sol-prime; idle squad roams via hop staying neutral; no-base player never triggers `warping`/`attacking`). **Netgate** still required (population churn brushes the swarm broadcast — invariant #8). **Equinox Phase 8 (2026-06-16) — drones ALWAYS present + attack regardless of presence:** (a) `hopTravelMs` default → **0**. The invisible mid-flight window (was 120s) left a TRAVERSING squad invisible/unhittable for its whole journey — members re-hop on arrival, so they sat in the despawned limbo near-continuously (the user's "why are the drones in transit?! they should always be on the actual game world, not in some ethereal warp"; live `/dev/population` showed 48/56 perpetually `inTransit`). With `hopTravelMs = 0` the hop is an atomic despawn-source/spawn-dest (deferred one macrotask) → a drone is a LIVE entity in a real sector at all times; paced travel still emerges from the **visible** per-hop `spoolMs` dwell (a squad lingers in each sector for the spool, then jumps — farther bases still take proportionally longer, just visibly). (b) `WaveDirector.assignReadyFactions` no longer gates on `ownerPresent` — a ready base draws a wave whether or not the owner is in-sector ("they should attack if the player is there or not"); the base's turrets defend, and an undefended base de-escalates (no surviving miners + peaceful timeout). 🔴 netgate. Locks: `WaveDirector.test.ts` ("STILL assigns … OFFLINE owner"). Full story: [docs/architecture/living-world.md](living-world.md) "Drone warp-in".

- **WS-E Phase-3 AI/lifecycle fixes (2026-06-20, plan `magical-summit`)**: four playtest-reported bugs, each fail-first locked. **(#15 hostile renders neutral)** disposition rides the discrete `bot_aggro` from `markBotHostileToFaction` (`if(!rec)` early-return); the warp `arrive` path spawns the member on a macrotask AFTER the control tick that pulsed `markSquadHostileToFaction`, so it stayed neutral until the next ~1.5 s pulse. `spawnBot`/`spawnLivingWorldBot` now take an optional `hostileToFaction { playerId, structureIds }` and mark hostility INLINE post-spawn; the director resolves it from `squadPool.squadOf(botId)?.targetFactionId` + the new `LivingWorldRoom.factionHostility()` hook (== `FactionLedger.membersOf`) in BOTH `respawnStep` + `HunterBotWarpController.arrive`, ONLY when the member lands AT its squad's target sector. **(#13/#19 attackers stack at one edge)** `BotCarry` gained `x,y` (captured from SAB in `despawnBot`); a WAVE hop arrives at the carry pose CLAMPED via `clampToSectorBounds` through the injected `HunterBotWarpController.arrivalPoseFor` resolver, while a ROAM hop returns null ⇒ the EDGE spawn (preserving "roamers enter from the edge, never on top"). **(#8 retreat reason)** `WaveDirector` retreat steps now carry a `RetreatReason` (`timeout`/`de-escalation`/`base-razed`, that precedence) threaded into the `wave_repelled` audit event's new optional `reason` field + the `wave_deescalated` serverLogEvent (both audit formatters surface it) — so a cadence audit distinguishes a healthy time-box phase-end from a grind. **(#22 roam avoids combat)** `pickRoamGoal` gained an optional `avoidCombat(sectorKey)` predicate (HOLDS when every live neighbour is in combat); `roamStep` builds it from each room's `recentCombat()` (non-null ⇒ combat in the ~5-min window) + audit-logs `roam_avoid_combat`. **(#9 anti-scatter regression lock)** the flocking + spawn-clustering + 6-min dwell already prevent roaming-squad scatter; `roamRegather.test.ts` locks that `flockStep` KEEPS assigning leader/follower roles to a roaming squad post-hop. Server-only, no wire/`SWARM_WIRE_VERSION` change. Locks: `LivingWorldBotHooks.test.ts` (inline-mark-when-handed-a-spec + `despawnBot` reads the LIVE SAB x/y/vx/vy/angle/angvel into the carry — the fail-on-revert lock for the #13/#19 SAB capture), `HunterBotWarpController.test.ts` (the resolved spec/pose is threaded through `arrive`→`spawnLivingWorldBot`), **`LivingWorldDirector.arrivalResolvers.test.ts` (the REAL director `hostileSpecFor` + `arrivalPoseFor` bodies — `squadOf().targetFactionId` + `squad.sectorKey===arrival` + dest `factionHostility()` for #15, and `targetFactionId!=null ⇒ clampToSectorBounds(carry)` else null for #13/#19 — fail-on-revert; NOT injected fakes)**, `WaveDirector.test.ts`, `population.test.ts`, integration `waveHostileOnArrival`(unit-relocated)/`roamAvoidCombat`/`roamRegather`. **Adversarial-review note:** the first-round #15/#13 locks injected FAKE resolvers / hardcoded the carry, so reverting the REAL resolver bodies left them green; the director + despawnBot tests above close that gap (each verified RED on revert of its production hunk). **Netgate** still required for the spawn/broadcast-touching pieces (#15/#13). Full story: [docs/architecture/living-world.md](living-world.md) "WS-E Phase-3 fixes".

- **Incoming-warp HUD feed (2026-06-13, Phase-4 P0)**: **SUPERSEDES the `warp_warning` sourcing in the two bullets above.** The banner read "Nothing incoming" while ships warped in because the only `warp_warning` broadcast was the wave step's FINAL-approach branch (`finalApproach > 0 && !squad.warned`) — roaming squads, lone fighters, and players never reached it (3rd-attempt root cause; diag `2026-06-13T15-48-18Z-84rbl1` showed 8 remote arrivals, 0 warnings). The warning now rides the SINGLE universal cross-sector hop choke point: `startSquadMemberTransit` (called from the `warp`/`attack`/`roam` branches alike) registers the departing squad as inbound to its next-hop sector in the new **`IncomingRegistry`** ([livingworld/IncomingRegistry.ts](../../src/server/livingworld/IncomingRegistry.ts), owned by the director), which broadcasts `warp_warning` to that destination room and `warp_warning_clear` on arrival (`reconcileIncoming()` at the `tick()` tail) / retreat. So roamers (`disposition:'neutral'`/amber), waves (`'enemy'`/red), and inbound PLAYERS (`'friendly'`/green) all show up by construction. The wave-step `finalApproach`/`squad.warned` broadcast is **DELETED**; the per-leg countdown self-expires client-side and the dedup (8 members → one banner) lives in `register()`. Schema: `WarpWarningSchema` gained an optional `disposition: 'enemy'|'neutral'|'friendly'` (back-compat); the client (`ColyseusClient` warp_warning handler) maps `enemy→'hostile'`. **Player back-channel:** `TransitOrchestrator.beginTransit` registers a friendly inbound + `cancelTransit`/arrival (`SectorRoom.handleClientReady`) clear it, routed through the cycle-safe `incomingPlayerSink.ts` singleton (`set/getIncomingPlayerSink`, set in `index.ts` beside the director; null ⇒ no player banner, e.g. `EQX_DISABLE_LIVING_WORLD`). Locks: `IncomingRegistry.test.ts` (register/clear/dedup/dest-change), `tests/integration/sectorRoom/incomingWarp.test.ts` (roamer A→B → B occupant gets a neutral warning, cleared on arrival — **the regression that all 3 prior fixes missed**), `wave-attack.spec.ts` (now asserts `data-warning-relation="hostile"`). **Netgate** required (the `warp_warning` broadcast is a live-loop piece — invariant #8).

- **In-sector squad herding — leader + FLOCKING/boids (2026-06-18, supersedes the WS-4 wedge-slot scheme; boost REMOVED, spawn-clustering ADDED)**: an IDLE, unassigned squad gathered in one sector flies as a leader-led FLOCK. `LivingWorldDirector.flockStep()` (called from `tick()` after `roamStep`) designates a LEADER (first active member in `botIds` order) given a wandering in-sector COURSE (a point on the radius-`FORMATION_DEST_RANGE` ring roughly OPPOSITE the leader's current bearing ± `FORMATION_LEG_SPREAD`, so every leg is LONG and the leader genuinely CRUISES instead of milling near a randomly-close point), and marks every OTHER member a FOLLOWER via `LivingWorldRoom.setBotFlockFollow(botId, leaderId, memberIds)`. **The director only assigns ROLES at the ~1.5 s control cadence; the STEERING is per-tick (60 Hz) in the drone brain** — which is the whole point (the old wedge-slot scheme pushed a STATIC slot every 1.5 s and `arrive`d/STOPPED at it, so it read as a static blob, not a formation). `HostileDroneBehaviour.tickFlock` runs continuous standard boids against LIVE poses each tick: COHESION toward the leader with an ARRIVAL ramp (the pull fades to 0 as the follower nears `FLOCK_FOLLOW_DISTANCE` — "slow down once close", no overshoot), SEPARATION from squad neighbours (cluster AROUND the leader at a spacing, don't pile on), ALIGNMENT with the leader's heading (the herd flies the course as one). The follower reads its leader's + neighbours' live poses via the **server-only `AiWorldView.resolveEntityInto(id, out)` seam** (wired to `SectorRoom.swarmEntityPoseInto`, a SAB read into a caller-owned buffer — NOT the shared `swarmEntitySnapshot` scratch that `self` aliases).
  - **NO BOOST — leader-wait/throttle instead (the user's "they just need to slow down once close… you can also just make the leader wait").** The first cut had followers apply the REAL player-boost impulse (`thrustImpulse × boostMultiplier`) when far; it OVERSHOT and flung the herd apart (ping-pong, swarm culled to 4). Removed. Followers now move ONLY at the calm `ai.thrust` cruise (`thrustMag = ai.thrust × flock.thrustScale`, scale capped at 1); the per-kind damping settles them with no overshoot. The catch-up problem (a follower can't outrun a leader at the same max-speed) is solved on the LEADER: `setBotFlockLeaderCourse` (new `LivingWorldRoom` hook → `HostileDroneBehaviour.setFlockLeaderCourse`) THROTTLES the leader's cruise to `LEADER_CRUISE_THROTTLE` (0.55) so full-cruise followers tighten on it, and `flockStep` HOLDS the leader at its OWN pose (course = current position ⇒ arrive ramps thrust to 0) while the squad is spread beyond `FLOCK_GATHER_RADIUS` (500), so it waits for the flock.
  - **SPAWN-CLUSTERING — a squad warps in as a herd (the root cause of the loose-looking herd).** The real reason the live herd looked strung-out was NOT the boids: `sectorEdgePose(rng)` gave EACH bot an INDEPENDENT random edge bearing, so a squad's 8 members spawned scattered across the whole sector edge (max gap ≈ the ~9000 u sector diameter) AND re-scattered on every roam hop — flocking then had to gather them at the slow ~80 u/s cruise (≈110 s), losing the race to the 45 s roam re-warp. NEW `squadEdgePose(squadKey, sectorKey, botKey)` ([population.ts](../../src/server/livingworld/population.ts)) gives every member of a squad ONE shared anchor bearing (deterministic FNV-1a hash of `squadKey:sectorKey`) + a small per-bot jitter, so the squad lands as a ~±300 u cluster and flocking just MAINTAINS it. Used by BOTH spawn paths: `respawnStep` (seed + combat respawn; squadKey via `squadPool.squadOf(botId)`) and the roam-hop `HunterBotWarpController.arrive` (via the injected `squadKeyOf` resolver). Still an EDGE spawn (radius unchanged) ⇒ the entry-only-ingress invariant holds; only the BEARING is shared. Integration trace: clustered spawn `gap0 ≈ 449` → flocking tightens to **~130 (the separation floor) and HOLDS** (vs the pre-cluster `gap0 = 9066` gathering at 80 u/s).
  - **VISIBILITY — roamers hop RARELY + traverse the sector; arrival stays at the EDGE (2026-06-19, live-diagnosis + playtest fix).** The flock math + clustering were correct, but in live play the herd was never SEEN. Live `flock_debug` (the env-gated diag, below) proved it: a squad spawns at the ~4600 u EDGE, the leader course targets a radius-2000 ring centred on origin, and the OLD ~45 s roam dwell was SHORTER than the edge→centre cruise — so the herd perpetually orbited the OUTER ring (leaders pinned at radius ~3600–4100) at/beyond a central player's interest (~3072 u) + view (~±650 u @ zoom 1). **The kept fix is the dwell: `roamIntervalMs` 45 s → 6 min** — roamers LINGER in a sector and fly LONG A→B chords (`FORMATION_DEST_RANGE` 2000) that cross the centre over the dwell (encounterable), then drift; frequent hopping is for WAVES bearing down on a base, not roamers. **A central-ARRIVAL experiment was REVERTED:** landing roaming squads ~450 u from origin (`squadCentralPose`/`arrivalPoseFor`) made them POP IN on top of a player/base at the centre (the 2026-06-19 playtest "they just spawned on top of me") — drones must ENTER from the edge and fly in, never materialise on top. So `squadEdgePose` is the sole hop-arrival pose again (edge), `squadCentralPose`/`arrivalPoseFor` are deleted, and `FORMATION_DEST_RANGE`/`ARRIVE` are back at 2000/250. Env-gated `flock_debug` (`EQX_FLOCK_DEBUG=1`, one event per idle squad per control tick → `GET /dev/events`: skip reason or `leaderR`/`maxGap`/`gathered`/`dest`) is the herd diagnostic + tuning lever. **WARP-IN WARNING (2026-06-19 playtest "the attack came out of nowhere"):** a WAVE's FINAL approach hop into its target sector now spools `waveApproachSpoolMs` (default **30 s**, the player warp) via the pure `hopSpoolMs(isWave, isFinalApproach, …)` — so the target gets a real ~30 s "incoming wave" countdown + the squad visibly winds up in the adjacent sector, instead of the 2.5 s-per-hop (`DRONE_HOP_SPOOL_MS`) surprise; INTERMEDIATE wave hops + roam hops stay `spoolMs`-fast so a multi-hop wave still converges (a uniform long spool was the pre-2026-06-18 minutes-never-arriving bug). The IncomingRegistry warning `etaMs` reflects THIS hop's spool, so the HUD countdown matches the real arrival. Lock: `LivingWorldDirector.hopSpool.test.ts`; tests set `waveApproachSpoolMs` small (harness 40) so a wave still reaches its target in-window. 🔴 netgate. **PARTIALLY BUILT (campaign 4.2, 2026-07-17):** the WAVE half of the cohesive SYNC-hop landed as **rally-before-breach** (see the Wave-attack bullet above — staged members hold at the rally ring, breach together, `rallyMaxMs` time-box). The ROAM half (gather-until-cohesive before every roam hop) remains deferred.
  - All SERVER-ONLY (no client brain → no lockstep surface, no wire bump); pure boids math in [src/core/ai/flocking.ts](../../src/core/ai/flocking.ts) (alloc-free, accumulator + caller-owned out). COMBAT overrides it (a waved/hostile drone pursues). The wedge-slot helpers in `src/core/ai/formation.ts` are now unused (kept for a future rigid-formation mode). **Netgate** required (AI tick + population motion brush the swarm broadcast — invariant #8). Locks: `flocking.test.ts` (arrival ramp + separation + cohesion), `HostileDroneBehaviour.flock.test.ts` (no boost / thrust capped at cruise, leader throttle, leader-hold), `population.test.ts` (`squadEdgePose` clusters a squad ≪ a sector-wide scatter), `tests/integration/sectorRoom/livingWorldFormation.test.ts` (gathered squad clustered `gap0<1500` + tight `gap1 < flockFollow + flockSeparation/2` from `shipTuning` (#18; was a fixed 400, written at 1×, which failed at the 2× default) + alive; AND a ROAMING squad re-forms CLEAR of the centre — `minRadius>2000`, i.e. enters from the edge, never on top — on hop arrival). **Tuning (`FLOCK_*` weights/radii, `LEADER_CRUISE_THROTTLE`, `FLOCK_GATHER_RADIUS`, `SQUAD_SPAWN_*_JITTER`, `FORMATION_DEST_RANGE/ARRIVE/LEG_SPREAD`, `roamIntervalMs`) is a feel knob — confirm on-device.**

- **Director-state persistence (Phase 5, 2026-06-14 — "the director should pick up and restart from any state")**: the process-global `LivingWorldDirector` now SURVIVES a server restart instead of re-seeding from scratch. It shadows its ABSTRACT squad continuity — each squad's `{squadId, kind, sectorKey, targetFactionId, state}` + the `WaveDirector`'s `waveCount`/`lastDispatchAtMs` maps — via a new `DIRECTOR_STATE_PUT` CRITICAL op into a singleton `director_state` row ([DirectorPersistence](../../src/server/livingworld/DirectorPersistence.ts), mirroring `SectorPersistence`'s injected `saveRow`/`loadRow` + `DIRECTOR_STATE_VERSION` + 24 h staleness; `null` hydrate ⇒ today's fresh seed). Persist fires on graceful shutdown (`index.ts`, BEFORE the drain) AND throttled at the `tick()` tail (`DIRECTOR_PERSIST_INTERVAL_MS` 60 s) — a CRITICAL enqueue from the 1.5 s control loop, **never the 60 Hz `update()`, so NO netgate**. Hydrate runs inside `start()` AFTER the seed/`rec.kind` loop: `SquadPool.restoreStates` + `WaveDirector.restore` overlay the persisted continuity, then the existing `respawnStep` re-spawns bots at each squad's RESTORED `sectorKey` (entry → direct; interior → edge-ingress + hop-traverse, so the entry-only-ingress invariant is preserved) and `waveDirector.plan` resumes the wave OR cleanly de-escalates per LIVE readiness. **Deliberately NOT persisted**: individual bot poses + in-flight `BotTransitController` warps (a mid-flight hop resets to the squad's sector on restart); the fixed 24-bot pool is always re-seeded (only ASSIGNMENTS persist; unknown squad ids skipped; a `DIRECTOR_STATE_VERSION` bump discards the row for a clean reseed). Locks: `DirectorPersistence.test.ts` (round-trip/version/staleness/corrupt), `SquadPool`/`WaveDirector.test.ts` (serialize/restore), [tests/integration/sectorRoom/livingWorldDirectorPersistence.test.ts](../../tests/integration/sectorRoom/livingWorldDirectorPersistence.test.ts) (two-boot faithful restart — a squad roamed into the interior resumes there, vs a no-row fresh-seed control arm). Full story: [docs/architecture/living-world.md](living-world.md) + [docs/architecture/persistence-and-migrations.md](persistence-and-migrations.md).

### Server rules in full (moved from src/server/CLAUDE.md)

The zone `CLAUDE.md` keeps a condensed form of these rules; this is the full wording with its lock tests.

**Living world** ([living-world](../../docs/architecture/living-world.md), [wave-attacks](../../docs/features/wave-attacks.md), [living-galaxy](../../docs/architecture/living-galaxy.md)):
- The director owns bot lifecycle. A quiet despawn never emits `ENTITY_DESTROYED` (its respawn trigger). Hostility uses `markHostile` + `bot_aggro`; no proactive hostility branch or wire flag. Null-guard every director reference (`EQX_DISABLE_LIVING_WORLD`).
- Drones go hostile only through the `FactionLedger` (a wave against a ready base, or a member hitting a drone); a player with no base is not hunted. A ready base draws waves whether or not its owner is present; a wave is time-boxed. 🔴 Drones prefer structures via `pickTarget` `priorityBias` (server-only).
- 🔴 Entry-only ingress: a from-nowhere drone spawn happens only at a galaxy entry sector, at the edge, never on top of a player. Squads traverse hop by hop; with zero hop travel a hop is an atomic despawn/spawn.
- Wave members landing at their target are marked hostile inline; a wave hop lands at the clamped carry pose, a roam hop at the shared squad edge pose (`squadEdgePose`).
- 🔴 `warp_warning` comes only from the `IncomingRegistry` (the hop choke point `startSquadMemberTransit`, plus player transit); never add a second source.
- 🔴 Flock roles are assigned by the director; steering is per tick in the drone brain (`resolveEntityInto`); server-only, no wire bump. Flock and spool numbers are feel knobs: confirm on device. `livingWorldFormation.test.ts`.
- Director persistence and galaxy stats run on the control loop, never in `update()`. The drone director is the only `/galaxy/snapshot` provider and incoming-player sink.

