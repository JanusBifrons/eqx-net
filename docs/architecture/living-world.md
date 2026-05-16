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
   `TransitStateMachine` (same 3 s vulnerable spool, cancel-on-death,
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

## Future work

- Per-kind hunter loadouts / threat tiers (extend the director's kind
  pick + `MountTargetView`, not the call sites).
- Multi-VM (Phase 9): the single-process direct-reference model becomes a
  Redis-coordinated director; the pure `population.ts` is unaffected.
- Difficulty scaling: `LIVING_WORLD_BOT_COUNT` and the control timings
  are already constructor options — wire them to a server-side config.
