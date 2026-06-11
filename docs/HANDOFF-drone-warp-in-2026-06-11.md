# HANDOFF — Drone warp-in refactor (playtest Issue 12 / plan E)

> **For a fresh agent.** All paths relative to `C:\Users\alecv\Desktop\eqx-net\eqx-net`.
> Branch: **`feat/drone-warp-in`** (off `main`). **Phase 1 committed** (commit `feat(galaxy): entry-sector metadata`);
> Phases 2–5 (the director refactor) remain. Source plan: section **E** of
> `docs/PLAN-playtest-bugs-2026-06-10.md`. This doc supersedes it with the user's
> confirmed design + the current state.

## The goal (user's words)
"Drones spawn by default in the Sol sector… they should never just magically
appear — they should enter at leaf sectors and take ~5 min of warping to reach
Sol." Confirmed design (2026-06-11):

- **Constant roaming population.** A fixed number of 8-ship squads EXIST and
  ROAM the galaxy (hop sector→sector). The old ambient neutral patrols
  (`AMBIENT_DRONE_FLOOR = 2`, boot-seeded) FOLD into this pool — entry-spawned +
  slow-roam, **neutral until shot**. No drone is boot-seeded into Sol; galaxy
  rooms boot `droneCount: 0`.
- **Respawn = warp-in from outside the map.** When a squad's ships are killed
  (typically after attacking the player), they respawn by **warping in at an
  ENTRY (edge) sector**, maintaining the population. Never materialise in place
  in an interior sector.
- **Trigger → one squad per 5 min.** When a faction's base is READY (the
  existing `factionBaseReadiness` trigger), the director routes a **SINGLE squad
  per 5 minutes** at that base's sector. That squad **traverses hop-by-hop from
  wherever it currently is** → travel time is EMERGENT (a squad 2 sectors away
  takes longer than one 1 away). Coincidental multi-squad convergence is
  ACCEPTED. It is NOT "every wave re-spawns at a leaf and marches a fixed 5 min."
- **Entry sectors = the galaxy edge** (the outermost hex ring; the 6 ring outers
  today). All drone ingress (roam-spawn + respawn) materialises ONLY at entry
  sectors, then hops inward via the galaxy graph.

## DONE — Phase 1 (commit `feat(galaxy): entry-sector metadata`)
`src/core/galaxy/galaxy.ts`: `getEntrySectors()` + `isEntrySector(key)` — derived
from the OUTERMOST ring (max hex distance from centre), so the set follows the
graph if it grows (NOT a hand-set per-record flag). For the current 7-sector
sunflower this is the 6 ring outers; `sol-prime` is never an entry sector.
Pure + unit-locked: `src/core/galaxy/galaxy.test.ts` (+3 cases).

## Existing architecture you build ON (READ FIRST)
The wave-attack system shipped 2026-06-10 (`docs/features/wave-attacks.md`); it
SUPERSEDED the old occupancy-hunter model. Key pieces (all under
`src/server/livingworld/`):
- `LivingWorldDirector.ts` — process-global owner of the bot pool; `tick()`
  control loop (~1.5 s, unref'd). `EQX_DISABLE_LIVING_WORLD` kill-switch.
- `director/WaveDirector.ts` — polls each room's `factionBaseReadiness()`,
  assigns idle squads to ready+unwaved factions via a `WavePattern`, runs each
  squad's `SquadBehaviour` to emit `WaveStep`s (`warp`/`attack`/`retreat`).
- `director/SquadPool.ts` — `LIVING_WORLD_SQUAD_COUNT × SQUAD_SIZE = 3 × 8`
  homogeneous squads + the shared state machine (`forming/idle/warping/
  attacking/retreating`). `respawnSectorFor`.
- `director/SquadBehaviour.ts` / `WavePattern.ts` (`EscalatingWavePattern`).
- `BotTransitController.ts` — the pure `TransitStateMachine` per bot; squad warp
  = 8 coordinated controllers in one tick (currently INSTANT to the target).
- `population.ts` — population/distribution helpers (`pickEntrySector` goes here).
- `faction/FactionLedger.ts` (per-room) + `src/core/faction/Faction.ts`
  (`isBaseReady`). Drones go hostile ONLY via a declared wave or a faction
  member attacking a drone — a player with no base is unhunted.
- `SectorRoom` hooks (the `LivingWorldRoom` interface): `spawnLivingWorldBot` /
  `despawnLivingWorldBot` / `markBotHostile` / `factionBaseReadiness` /
  `setFactionUnderWave` / `markSquadHostileToFaction` / `purgeFactionHostility` /
  `broadcastWarpWarning`. `LivingWorldBotHooks.spawnBot` already does sector-edge
  pose + `warp_in` broadcast + join-grace.
- Test harness: `bootLivingWorldTestServer` (multi-room, injects tiny timings +
  a seeded RNG). Locks: `population.test.ts`, `BotTransitController.test.ts`,
  `tests/integration/sectorRoom/livingWorldDirector.test.ts` + `livingWorldHooks.test.ts`.
- Envs: `EQX_BOT_SPOOL_MS` (squad-spool override) already exists; add an
  `EQX_BOT_HOP_MS`-style override for hop-travel (fast E2E timeline).

## REMAINING — Phases 2–5 (the director refactor)
**Phase 2 — hop-travel mechanism (split depart/arrive; default fast-equivalent).**
Today the cross-room hop is instantaneous at spool end (`BotTransitController` /
squad warp lands directly on target). Add a `hopTravelMs`: depart = despawn
source + stash the bot's carry (kind/health), timer `hopTravelMs`, arrive =
spawn at the DESTINATION EDGE via `LivingWorldBotHooks.spawnBot` (already does
edge pose + `warp_in` + join-grace; arrival `hasFreeSlot` check w/ self-heal to
respawn). Applies to BOTH squad warps and any singleton movement. `onDispose`
clears timers. New `EQX_BOT_HOP_MS` boot env for tests.

**Phase 3 — roaming + entry-spawn + per-trigger dispatch (the core).**
- Squads ROAM: idle squads slow-hop the galaxy graph (random/biased walk),
  spawning + respawning ONLY at entry sectors (`getEntrySectors` +
  `pickEntrySector`), neutral until shot.
- Respawn-via-warp-in: a killed squad's ships respawn at an entry sector
  (population maintenance), not in place.
- Dispatch: on `factionBaseReadiness === ready`, route ONE squad per 5 min at
  that faction's sector; the squad TRAVERSES hop-by-hop from its current
  location (emergent travel via Phase 2). The `WarpInWarningBanner` countdown
  stays the in-sector telegraph for the FINAL hop at the target. Keep the
  `EscalatingWavePattern` seam but the cadence is "≤1 dispatch / 5 min / ready
  faction", not "assign all idle squads at once".

**Phase 4 — retire ambient boot-seeding.**
- Galaxy rooms get explicit `droneCount: 0` (CAREFUL: the non-testMode room
  default is 30; the `GalaxySector.droneCount` field currently = `AMBIENT_DRONE_FLOOR`
  — change the seeding path, not just the field, and verify nothing regresses).
- Fold the ambient floor into the roaming pool (entry-spawned, slow-hop) OR drop
  it — the user chose **keep, entry-spawned**. Engineering/test rooms keep local
  seeding (`dronePoses`, `structurePoses`, etc.) untouched.
- `SectorPersistence` stops persisting `kind===1` (drone) rows; bump
  `CURRENT_SCHEMA_VERSION` 1→2 in `src/server/rooms/SectorSnapshot.ts` (clean
  reseed). Cold-boot empty interior is ACCEPTED.

**Phase 5 — locks + verify.**
- INVARIANT: in galaxy sectors the ONLY drone-creation path is the director's
  entry-sector edge-spawn-with-`warp_in`.
- Integration (`bootLivingWorldTestServer`, tiny timings + seeded RNG): every
  `BOT_SPAWNED`/`bot_spawn` sectorKey ∈ entry set; interior sectors reached only
  via despawn→(≥`hopTravelMs`)→spawn pairs; galaxy rooms boot zero drones;
  `EQX_DISABLE_LIVING_WORLD` still fully peaceful.
- E2E: update `tests/e2e/wave-attack.spec.ts` for the entry-route; NEW spec
  "drones never magically appear" — `/dev/events` `bot_spawn` rows all in entry
  sectors + client `warp_event` correlation. Fast timeline via `EQX_BOT_SPOOL_MS`
  + the new `EQX_BOT_HOP_MS`, a dedicated Playwright project.
- ONE `pnpm e2e:netgate` run at the end (population churn brushes the swarm
  broadcast — invariant #8).

## Project rules that bind (CLAUDE.md)
- **#8 netgate** for the live-loop pieces (population churn / swarm broadcast).
- **#11** schema bump (`CURRENT_SCHEMA_VERSION` 1→2) on the persistence change;
  ship-kind / structure-kind catalogues stay append-only.
- **#13** failing-test-first at the level where the bug lives; **#14** no
  hot-loop allocation in `tick()`/`update()` paths.
- **Never deviate from the plan silently** — build this SHAPE; STOP + flag if a
  step can't hold. **On-device evidence beats theory** — the deterministic gates
  are not a playability signal for the live loop.
- Defer the full suite + netgate to PR CI per the user's standing preference;
  local loop = typecheck + new tests + lint.

## Status / how to resume
- `git checkout feat/drone-warp-in` (branch is pushed). Phase 1 is in; start
  Phase 2. Commit per phase (green inner loop each time).
- Memory: `drone-warp-in-design.md` (this design) + `MEMORY.md` pointer.
- NOT yet pushed as a PR — E is not a shippable unit until at least Phases 2–4
  land + the invariant lock (Phase 5) is green.
