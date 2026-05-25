# Mobile performance regression — Living World era investigation

> **SUPERSEDED (2026-05-24 EOD):** the canonical state of this investigation is **[`docs/HANDOFF-mobile-perf-2026-05-24.md`](../HANDOFF-mobile-perf-2026-05-24.md)**. Read that first. This file is the earliest diagnosis (kept for historical traceability of the journey) — several of its conclusions were later falsified by capture data. See the handoff doc's "The story compressed" section for the corrected causal chain.

Status: historical diagnosis-only. No code changes. Cross-checked against the actual code at the cited SHAs and the actual captures on `origin/feat/perf-floor`.

## Timeline (evidence-grounded)

- **Living World landed 2026-05-16** (`395da41`..`e5f8319`, 17:02–19:34 BST). `LIVING_WORLD_BOT_COUNT = 25` hunter bots that funnel into the player's sector (`LivingWorldDirector.ts:55` + step-2 distribution math). Per-client cost it adds: **24-25 hunter drones in the player's sector when a player is present** (m6rq2t population_report: `sol-prime {players:1, bots:24}`); a 1.5 s control loop posting `bot_aggro` + `BOT_TRANSIT_STARTED` events; `warp_in`/`warp_out` broadcast on every bot hop (`LivingWorldDirector.ts:326-332`). Plus 2 ambient drones per sector (`AMBIENT_DRONE_FLOOR=2`). Effective in-sector hostile entity count for a solo player went from ~0 to ~24 overnight.
- **`af605ec` (2026-05-17 17:46)** — `DRONE_RESIM_BUDGET=12`, capped per-snapshot client AI re-sim. Bounded `O(replayWindow × K)`, K=12. Pre-pivot capture `m6rq2t` (24 bots, in-pack) shows `ticksAhead` growing 9→91 over 13 s of combat — the "spiral".
- **Snapshot-interpolation pivot — `0eeb526`..`a75054d` (2026-05-18 18:10–19:37)**. Deleted: `droneRelevance.ts`, `DRONE_RESIM_BUDGET`, `AiController.tickOnly`, `tickClientAi`, the `Reconciler.reconcile` 6th `replaySeed` param. Added: per-frame `interpolateSwarmPose` (allocates a 3-slot array + sort + lerp per drone per frame, `swarmInterpolation.ts:132-238`) and a kinematic predWorld follower (`ColyseusClient.ts:2478-2493`). Wire saving: 312 KB → 31 KB (-90%). Capture `1fc0oe` (post-pivot, same evening) shows `ticksAhead` 8→320 over 23 s — **the same spiral pattern**, with 5.55% stalls at the 110.8 ms quantum.
- **`9e23436` (2026-05-22 18:18)** — 60 Hz internal work-loop cap; halves processed work on a 90 Hz phone.
- **`45400f3` (2026-05-22 19:05)** — touch devices default to main-thread renderer (worker IPC blamed for the 110.8 ms stall). Smoke pair `721mwk` (worker on, 1.87% stalls) vs `iph9cv` (worker off, 0.09% stalls) was the "decisive" evidence.

## What the captures actually show

| Capture | Date / time UTC | Duration (game) | rafTick p50 | Stalls >100ms | Stall cluster | ticksAhead p95 | Drones in sector | Combat | Worker | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `m6rq2t` | 05-17 15:34 | 28 s | 11.1 ms | 5 (0.93%) | 122, 133, 188, 266 | 91 | 24 hunters / 1 player | yes | on | Pre-pivot; triggered `af605ec` |
| `j57poe` | 05-17 17:05 | 30 s | 11.1 ms | 2 (0.34%) | 144, 255 | (no spiral) | 21 / 1 | yes | on | Post-`af605ec` |
| `cfyb5r` | 05-18 15:32 | 27 s | 11.1 ms | 5 (0.90%) | 111, 133, 277 | 39 | 23 / 1 | yes | on | Pre-pivot |
| `1fc0oe` | 05-18 18:56 | 75 s | 11.1 ms | **75 (5.55%)** | 110.9 ×many | 95-320 | 25 / 1 | yes | on | **Post-pivot, regressed worse than pre-pivot** |
| `eajc6g` | 05-18 19:18 | 72 s | 11.1 ms | 5 (0.30%) | 110.9, 365, 410 | 25 | 19 / 1 (after transit) | yes | on | Post-pivot, healthy |
| `721mwk` | 05-22 17:39 | 53 s | 22.2 ms | 38 (1.87%) | 110.7 ×many | (16 final) | n/a | yes | on | Post-60Hz-cap |
| `iph9cv` | 05-22 17:56 | 99 s (~50 s game) | 22.2 ms | 3 (0.09%) | 110, 111, 133 | 5 | n/a | sparse | OFF | "Decisive" healthy capture; mostly galaxy-map flipping |
| `o4n4pw` | 05-22 19:37 | 67 s | 22.2 ms | 14 (0.48%) | 110.8 ×many | 24 | n/a | yes (290 fires) | OFF | Healthy *during* combat; 13 of 14 stalls happen at t=66-75 s, *after* combat ends |
| `su7udq` | 05-22 20:03 | 22 s | 22.2 ms | **61 (10.59%)** | 110.8 ×many | 25 | n/a | no fires | OFF | Worker-off; bad |
| `x8hdwj` | 05-22 20:04 | 16 s | 22.2 ms | **46 (10.00%)** | 110.9 ×many | 60 | n/a | 21 fires | OFF | Worker-off; bad |

Drone counts for May-22 captures: `population.ndjson` is empty — Living World was running (server-side, default) but the diag stream didn't include it after the perf-floor branch's diag changes. Hunter pool is unchanged at 25.

The pattern is unambiguous: **the 110.7–110.9 ms stall cluster is the dominant signature across every capture from pre-pivot through worker-off**. It precedes the snapshot-interp pivot (m6rq2t, cfyb5r). It precedes the worker hypothesis (every post-cap capture has it). It survives both fixes. `iph9cv`'s "decisive" 19× reduction is partly confounded — iph9cv spent most of its 99 s in galaxy-map (only 12-15 s game-phase per stint), versus 721mwk's continuous game-phase play.

## The four questions, answered

### 1. Was lockstep-AI's scaling failure intrinsic, or Living-World-induced?

**Living-World-induced.** Evidence: the canonical pre-pivot "spiral" diag `m6rq2t` ran with **24 hunter bots concentrated in the player's sector by `LivingWorldDirector`** (`m6rq2t/population.ndjson` line 1: `sol-prime {players:1, bots:24}`). The k-cap commit's own evidence chain (`af605ec`) names "inside the bot pack NEAR≈ALL" as the failure mode. With pre-Living-World drone density (~0-3 in-sector), `NEAR ≪ N` always and `DRONE_RESIM_BUDGET` would never engage. The `feel-test-lockstep` canary at 10 drones — used as the lockstep regression lock — was below the K=12 budget and provably unaffected. The lockstep algorithm wasn't broken at 10; it was broken at 24, and the 24 came from a server-side population mandate, not from anything intrinsic to the prediction algorithm.

### 2. What is the dominant per-frame cost in the current (post-pivot) architecture?

**INDETERMINATE — but it is NOT what the post-pivot fix narratives claim.** Three claimed causes have been individually falsified by the captures available:

- **Snapshot reconcile is not the cost.** `applyMs` p50 is 0.9–2.6 ms across all four May-22 captures (`snapshots.ndjson:snapshot_applied`). Per-snapshot reconcile work is < 3 ms even in the spiral-progress captures.
- **Worker IPC is not the sole cause.** The 110.8 ms cluster appears in every worker-off May-22 capture (`iph9cv` 3 events, `o4n4pw` 14 events, `su7udq` 61 events, `x8hdwj` 46 events), and the cluster *pre-existed the worker-on era too* (m6rq2t and other May 17–18 captures show identical 110.8 ms quanta).
- **GC longtasks are not the cause.** Bad captures `su7udq`/`x8hdwj` have **2 and 4 longtasks** respectively but **61 and 46 raf-gaps**. The 45400f3 commit explicitly observed `longtaskCount30s=0 / rafGapCount30s=5-22` — JS was not blocking. That observation still holds after the worker-off "fix" and after the 60 Hz cap.

The 110.7–110.9 ms quantum is *deterministically reproducible*, never random, and *survives every fix shipped on the perf-floor branch*. It is something below the JS thread that the captures-as-currently-instrumented cannot see (compositor commit, vsync re-sync, scheduler quantum, OS-level main-thread suspension). The existing instrumentation cannot localise it further.

What *did* go up post-pivot: per-frame `interpolateSwarmPose` allocates a `populated[]` array + sort per drone per frame (`swarmInterpolation.ts:150-165`), called once per drone per frame from `updateMirror` (`ColyseusClient.ts:2480-2493`). With ~25 in-interest hunters this is ~25 small allocations/frame + a kinematic `setShipState` write into predWorld. This is plausible GC pressure — but the longtask counts say it does not produce blocking pauses in these captures, so it cannot be the 110 ms cluster.

### 3. Which fix path is correct?

**(d) something else — invest in instrumentation before any larger refactor.** With the available data:

- **(a) "keep snapshot-interp + cut its dominant cost"** is unfounded — the dominant cost is unidentified.
- **(b) "restore lockstep + different scalability fix"** would re-introduce a known O(replayWindow × N) cost surface against a *Living-World-mandated* N=24 and re-litigate the in-pack spiral.
- **(c) "restore lockstep + throttle Living World on mobile"** is the *most defensible* path on the evidence available: the failure mode that originally motivated the pivot (`m6rq2t`) was the in-pack density, not the algorithm. Throttling `LIVING_WORLD_BOT_COUNT` on a mobile-tagged session — or capping per-sector hunter concentration — collapses N to where `DRONE_RESIM_BUDGET` never engages. The pivot solved a symptom of a server-side population choice with a client-side architectural rewrite that, in the captures, did not actually reduce the on-device stall. The 110 ms cluster persists either way; addressing it is orthogonal to the pivot/lockstep question.

The honest answer: the captures cannot pick between (c) and the open hypothesis that 110 ms is a device/browser/network quantum unrelated to any client architecture, in which case the entire snapshot-interpolation pivot solved a phantom problem.

### 4. Smallest experiment that proves the chosen answer

Two probes, both order-hours and both falsifiable:

1. **Living World throttle probe**: gate `LIVING_WORLD_BOT_COUNT` behind a server flag, set to 0 in one session and 25 in another, both with the *current* main code (snapshot-interp). If the 110 ms cluster vanishes at N=0 it is Living-World-coupled; if it persists at N=0 it is not, and the pivot's premise is wrong.
2. **Below-JS probe**: add a frame-boundary timestamp from a `MessageChannel` echo + a `requestAnimationFrame`-vs-`postMessage` interleave timer; capture a stalled session. If the MessageChannel echo arrives on time but rAF is late, the stall is in compositor/vsync, not in main-thread JS — and *no client-architecture fix* can address it. If the MessageChannel echo is also late, something on the main thread *is* blocking despite the longtask observer disagreeing.

Both probes are < 1 day of work. Either result decides the next month of work.

## What this diagnosis does NOT settle

- **The mechanism behind the 110.7-110.9 ms cluster is not identified.** Captures show longtaskCount low while raf-gaps spike at exactly that quantum. The diag stream does not include below-JS instrumentation (compositor commit, vsync, OS scheduler). Probe (2) above is required to resolve.
- **Whether Living World N=25 vs N=0 changes the stall pattern is untested.** No capture exists with Living World disabled on the current main code. Probe (1) above is required.
- **No capture exists where the player is in active combat against 20+ drones on post-pivot mobile.** The `o4n4pw` capture (closest available) shows 0.48% stalls *during* combat, which contradicts the "post-pivot is broken in combat" assumption — but it also lacks `population.ndjson` data so the actual in-sector drone count is unknown.
- **Whether the pivot improved or worsened the mobile experience, holding Living World density constant, is undecided** — the cleanest comparison would be the same scene under both architectures, which the captures do not provide.

## Falsified prior claims

- **CLAUDE.md root invariant #12** states snapshot-interp "dissolves the second-correction-path problem for drones". True architecturally — but the captures show it did not reduce on-device stall rate (compare `cfyb5r` 0.90% pre-pivot to `1fc0oe` 5.55% post-pivot, both ~25 bots, same evening). The architectural cleanup happened; the user-perceived fix did not.
- **Commit `45400f3` ("worker IPC was the 110 ms stall cause")** is falsified by `su7udq` (10.59% stalls) and `x8hdwj` (10.00% stalls), both captured with `useWorker:false` confirmed in `other.ndjson:renderer_path_chosen`. The 110.8 ms cluster persists with worker off. The smoke pair that "proved" the worker hypothesis is confounded: `iph9cv` spent most of its capture in galaxy-map phase, not game, so it had vastly less per-frame work than `721mwk`.
- **`docs/LESSONS.md` 2026-05-22** claims "RAF gaps without long tasks → worker IPC". The same signature (gaps without longtasks) is present in pre-worker-era captures and in worker-off captures, so it cannot be a worker-specific signal.
- **`docs/architecture/reconciler-replay-scaling.md` §9 ("In-pack completion")** correctly identifies the spiral mechanism but attributes it to a client-AI architectural defect. The captures show the spiral re-appears post-pivot (`1fc0oe` ticksAhead 8→320), which the pivot supposedly retired the code path for. The spiral is therefore not specific to client AI re-sim — it is a generic prediction-window-grows-as-snapshot-handling-slows feedback loop that any per-frame work surface can trigger.
- **`af605ec` commit body**: "scales to the 500 target" — never tested on-device above N=25; the K=12 cap was retired three commits later before any 500-entity on-device measurement existed.
