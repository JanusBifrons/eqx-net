# Wave Attacks — drone squads vs your base

> Status: shipped 2026-06-10. Plan:
> `.claude/plans/i-d-like-you-to-resilient-hellman.md`. Supersedes the
> occupancy-driven "hunters converge on any player" Living World behaviour.

## The loop

Build a base → start extracting → get attacked in waves → defend.

1. **Build.** Place a Capital (core), a Miner, a Solar (power), and a Turret
   (defence). While your base is incomplete you are left alone — a player with
   no base roams an unhunted galaxy.
2. **Trigger.** Once your base has **a constructed Capital + ≥1 Miner + ≥1 Solar
   + ≥1 Turret**, the director marks your base a wave target.
3. **Warning.** A drone squad spools to warp into your sector. Every player in
   the sector sees a HUD countdown banner — **"8 × Legionnaires warping in — Ns"**
   — for the full ~5-minute spool. (All warps now take 5 minutes to spool; your
   ship is damageable the whole time, so changing sectors mid-siege is risky.)
4. **Attack.** The squad warps in **together** and attacks, prioritising your
   **structures** over your ship (the Capital and Miners first). Your turrets
   fire back automatically.
5. **De-escalation.** The wave stops when **all your Miners are destroyed AND
   you've dealt no damage to a drone for a while** (a peaceful timeout). The
   squad stands down and retreats. Rebuild a Miner (or shoot a drone) and the
   waves resume.

## Factions & hostility

You + the structures you own (in a sector) are one **faction**. If you OR any of
your structures (e.g. a turret) damages a drone, the **whole faction** becomes
hostile to the drones — they'll engage your base, not just the structure that
shot them. Incoming drones tasked against your base show **red on your radar**
before they reach you.

## Squads

Drones roam in **squads of 8** with one strategic brain: they warp together, go
hostile together, and retreat together, but each drone flies and picks targets
independently. v1 squads are homogeneous "Legionnaires" (a flavour codename for
the fighter hull); difficulty, squad count, intervals, and mixed-kind squads are
all tunable later via the `WavePattern` strategy.

## Architecture

See [docs/architecture/living-world.md](../architecture/living-world.md) for the
director internals (the `WaveDirector` / `SquadPool` / `SquadBehaviour` /
`WavePattern` composition and the per-room `FactionLedger`).

## Ops

`EQX_DISABLE_LIVING_WORLD=1` disables all director-owned drones (no waves), for
peaceful building/playtests. Ambient per-sector patrol drones remain but stay
neutral until shot. `EQX_BOT_SPOOL_MS` overrides the drone-squad spool (E2E /
tuning); the player spool is overridable per-room via the testMode
`transitSpoolMsOverride` join option.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](../architecture/server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Wave-attack refactor (2026-06-10, plan `i-d-like-you-to-resilient-hellman`)**: the occupancy-distribution model above is **RETIRED**. The director no longer spreads bots by player-count or aggros on sight — `tick()` step 2 (`HunterBotDistribution.plan` migrations) and step 3 (`forEachActive → markBotHostile`) are **deleted**. Drones now go hostile ONLY via the per-room **`FactionLedger`** ([faction/FactionLedger.ts](../../src/server/faction/FactionLedger.ts)): a wave declared against a ready base, OR a faction member attacking a drone (the reactive `escalateFactionOnDroneHit` via the new `LeafDeps.onDroneDamaged` seam in `swarmDamageStrategy`). A player with **no base is unhunted**. The 56 bots are organised into `LIVING_WORLD_SQUAD_COUNT × SQUAD_SIZE = 7 × 8` homogeneous **squads** (Living Galaxy P2 scaled 3→7 for the 21-sector galaxy, 2026-06-15) ([director/SquadPool.ts](../../src/server/livingworld/director/SquadPool.ts)) with a shared state machine (`forming/idle/warping/attacking/retreating`); the **`WaveDirector`** ([director/WaveDirector.ts](../../src/server/livingworld/director/WaveDirector.ts)) polls each room's new `factionBaseReadiness()` hook (Capital+Miner+Solar+Turret = ready, pure `isBaseReady` in [core/faction/Faction.ts](../../src/core/faction/Faction.ts)), assigns the **NEAREST** idle squads to ready+unwaved factions via a **`WavePattern`** strategy (v1 `EscalatingWavePattern` = 1 squad) — `assignReadyFactions` sorts spare squads by `hopDistance(sq.sectorKey, base)` (galaxy-graph BFS depth, `population.ts`) so the closest roaming group is dispatched (the user's "review the pools … direct the nearest roaming groups" directive; deterministic squadId tie-break). Lock: `WaveDirector.test.ts` nearest-dispatch + `population.test.ts` `hopDistance`, and runs each squad's **`SquadBehaviour`** to emit `WaveStep`s (`warp`/`attack`/`retreat`) the director executes. Squad warp = 8 coordinated `BotTransitController`s in one tick (partial arrival under slot contention / mid-spool death is accepted; respawn rejoins via `SquadPool.respawnSectorFor`). `attack` re-pulses `markSquadHostileToFaction` (player + owned structure ids) every control tick (beats the 30 s `FORGET_TICKS` decay) + `setFactionUnderWave(true)` (gates the drone-AI structure-target view built once-per-tick in `aiTickRunner` `fillStructureTargets`). **Wave resolution — TIME-BOXED phases (Phase-1 issue 4, 2026-06-18).** A wave `retreat`s on ANY of: base fully razed (no `factionBaseReadiness` entry), de-escalation (`shouldDeEscalate`: no surviving Miners AND peaceful past `FACTION_PEACEFUL_TIMEOUT_TICKS`), OR — NEW — `waveMaxAttackMs` (default 3 min) of being `attacking` (`WaveDirector.attackStartedAtMs` time-box). `retreat` → `setFactionUnderWave(false)` + `purgeFactionHostility` + `clearTarget`; re-trigger is readiness-driven, so the next dispatch cadence sends a FRESH squad — discrete PHASED assaults. **Why the time-box:** a 12 h playtest audit showed `wave_repelled=0` — waves NEVER resolved: a base turret keeps the faction "at war" so de-escalation can't fire, and killed wave members respawn at the galaxy EDGE (entry-only-ingress invariant) and trickle back, so the squad self-heals forever, the faction stays `assigned`, and no second wave is ever dispatched (one perpetual grind: 8 waves / 59 kills / 12 h, all kills by the base turret). The time-box is a FEEL knob (`waveMaxAttackMs` < `dispatchIntervalMs` for a lull) — **verify on-device.** Lock: `WaveDirector.test.ts` time-box case + `waveGalaxySnapshot.test.ts` "resolves then re-dispatches". **Still-open issue-4 follow-ups (need on-device tuning):** ~~the assault still TRICKLES in~~ **BUILT (campaign 4.2, 2026-07-17): rally-before-breach** — while a wave squad is `warping`, members whose next hop IS the goal HOLD at that rally-ring sector (`decideRallyRelease` in `LivingWorldDirector.ts` + the per-squad `rallyHeldSince` window) until every traversing squadmate reaches the ring, then ALL begin the telegraphed final approach in one control tick; time-boxed by `rallyMaxMs` (default 90 s, feel knob) so a respawn-straggler cycle can't stall the wave, and never applied to an `attacking` squad (reinforcements flow unheld). Lock: `LivingWorldDirector.rallyBreach.test.ts` (fail-on-revert verified). Roaming churn (4293 `wave_incoming` in 12 h) remains open. Drones target structures over players via `WeaponMountController.pickTarget` `priorityBias` (`AiStructureView.priority`, server-only — no wire bump, the client never ticks the drone brain). New hooks on `LivingWorldRoom`: `factionBaseReadiness`/`setFactionUnderWave`/`markSquadHostileToFaction`/`purgeFactionHostility`/`broadcastWarpWarning`. Warp-in HUD: one `warp_warning` broadcast per squad to the destination ("8 × Legionnaires"; "Legionnaire" is a label only — wire `shipKind` stays `fighter`, invariant #11). 5-min `SPOOL_DURATION_MS` for all warps; `EQX_BOT_SPOOL_MS` overrides the drone spool, testMode `transitSpoolMsOverride` the player spool. Locks: `Faction`/`FactionLedger`/`SquadPool`/`SquadBehaviour`/`WaveDirector` unit tests + the rewritten `livingWorldDirector.test.ts` (seed-and-hold + Req-#6 no-hunt-without-base). **Netgate** required for the live-loop pieces (AI structure-targeting + fire pass + escalation gating + the `warp_warning` broadcast). Full story: [docs/features/wave-attacks.md](wave-attacks.md).
