# Reconciler replay scaling — WIP handoff (2026-05-16 → tomorrow)

> **⚠️ SUPERSEDED (2026-05-18) — drone replay re-sim no longer exists.**
> The entire premise of this document (relevance-culled *client drone
> re-sim* during reconciler replay — Option A, `droneRelevance.ts`,
> `DRONE_RESIM_BUDGET`, the `replaySeed` drone anchor) was **deleted** by
> the drone-snapshot-interpolation pivot. Drones are pure
> snapshot-interpolated; `Reconciler.reconcile` has no drone seed param
> and replay no longer touches drones. Read
> [`drone-snapshot-interpolation.md`](./drone-snapshot-interpolation.md).
> Retained as investigation history and because the *player* reconcile /
> bulk-gap-smoothing / `playerCorrectionHalfLifeMs` work it also covered
> is still live on `main`.

> **Status (2026-05-17): SHIPPED — Option A (relevance-culled re-sim).** The
> §6 fork was decided (user-selected fork **A**); it is implemented, green on
> every deterministic gate, and the scaling lock proves the win host-robustly.
> §2–§5 below are retained as the investigation/measurement history that
> motivated the design; **the authoritative outcome is [§9](#9-resolution-2026-05-17--option-a-shipped)**.
> The blanket-freeze WIP this doc originally described was *superseded by*
> Option A (it stayed unmerged exactly as this doc demanded).

---

## 1. What shipped vs what's pending

| Item | State |
|---|---|
| **Living-world warp-churn fix** (`playerStickyMs` occupancy hysteresis) | ✅ **Merged to main** (`89d009e` → merge `e2ab0b4`). Shipped, done. |
| **Reconciler replay scaling** (this doc) | ✅ **SHIPPED — Option A (relevance-culled re-sim)**, 2026-05-17. Measured root cause → fork A chosen → implemented → green on all deterministic gates + the host-robust scaling lock. See [§9](#9-resolution-2026-05-17--option-a-shipped). |

## 2. The problem (from on-device evidence)

Phone smoke-test diag `diag/captures/2026-05-16T20-03-36-048Z-a3f5na`
(clean LAN, `rttMs ~9`, `ticksAhead 3` — **not** a network issue) showed
**116–266 ms client frame stalls** when the player **changed sectors**
(`sol-prime → vega-reach`) and the living-world pack re-funnelled to
follow. Server was fine (worst tick 1.19 ms / 16.67 ms budget). The
user's constraint is explicit and correct: the architecture targets
**~500 entities/sector** (interest grid, binary swarm wire, SAB,
1000-entity lag-comp ring; server proven at 33 swarm + 25 AI). So this
is a **client scaling defect** and the fix must **scale, not throttle**
the entity count.

## 3. Measured root cause (numbers, not theory)

Measured headlessly over the real core cost-centers
(`PhysicsWorld`/`AiController`/`HostileDroneBehaviour`) with
`performance.now()`. (NB: `vitest bench` is repo-wide broken under
vitest 2.1.9 — emits 0 samples even for the committed
`benchmarks/physics-tick.bench.ts`. Use a `performance.now()` `test()`;
it gates in `pnpm test`/`test:integration` anyway. **Pre-existing infra
gap worth its own ticket — `pnpm bench` is currently a no-op signal.**)

| cost-center | N=25 | N=100 | N=250 | N=500 |
|---|---|---|---|---|
| warp-in burst (spawn + AI + `setHullExposed`) | 0.4 ms | 1.9 ms | 3.9 ms | **2.6 ms** |
| reconciler replay @ ticksAhead=8 (healthy) | 1.5 | 3.7 | 4.2 | **12.8** |
| reconciler replay @ ticksAhead=48 (stall window) | 7.3 | 10.5 | 20.6 | **47.9** |

- **Spawn burst + shield/hull `setHullExposed` are exonerated** —
  ~2.6 ms at N=500, identical with/without shield. The
  synchronous-spawn hypothesis was **wrong** (measurement killed it).
- **The defect is `Reconciler.reconcile` replay: O(ticksAhead × N).**
  The replay loop is uncapped (`replayStart..currentTick`, up to
  `BUFFER_SIZE=128`); per replayed tick it `world.tick()`-steps every
  drone body **and** the `perReplayTick` callback re-ticks every drone's
  `HostileDroneBehaviour`. `ticksAhead` hit 44–49 during the
  sector-change handoff (capture confirms) → ~48 ms at N=500 ≈ 3× a
  frame; multiple corrections/unstable-second compound into the 266 ms
  stall.

## 4. The fundamental finding (the load-bearing insight)

**That O(ticksAhead × N) is not an accident — it IS the chapter-2
Phase C lockstep mechanism.** Per `src/client/CLAUDE.md` ("Drone
prediction is reconciled, not just dead-reckoned") and
`docs/architecture/ai-lockstep.md` (Phase C): the per-replay-tick
`tickClientAi` re-sim is *deliberate* — it forward-extrapolates every
in-interest drone to `currentTick` in lockstep with the server. The
`feel-test-lockstep` canary (`swarmSnapP50 < 15`) exists to lock exactly
this.

> **There is no free lunch.** Tick-accurate N-drone lockstep is
> inherently O(ticksAhead × N) per snapshot. You cannot have *both*
> tick-perfect 500-drone lockstep *and* an O(1)-in-N reconcile. Scaling
> to the design target requires changing the lockstep **model**, not
> just scoping the loop.

## 5. What's on the branch, and why it can't merge as-is

`fix/reconciler-replay-scaling` implements **player-scoped replay**:

- `World.unlockBody(id)` — counterpart to the existing `lockBody`.
- `Reconciler.reconcile(..., freeze?)` — locks the supplied bodies for
  the (uncapped) replay loop in a `try/finally`; `replaySeed` still
  anchors drones, so they hold at their server-authoritative pose
  through the player replay (no inertia drift → the per-replay-tick AI
  re-sim becomes dead work).
- `ColyseusClient` — passes the in-interest **drone** keys
  (`_aiRegisteredIds`; NOT asteroids — permanently locked at spawn) as
  `freeze`, and drops `tickClientAi` from `perReplayTick` (keeps
  `applyRemoteInputs` — remote ships are few, unaffected).
- Regression lock: `tests/integration/reconcilerReplayScaling.test.ts`
  (lives in the **integration** runner — singleThread/serial — because
  two 500-body Rapier worlds OOM the parallel unit pool; ratio-based
  assertion so it's host-robust).

**Proven win:** reconcile at N=500/ticksAhead=48 goes **63 → 17 ms
(≈4×)**, flat in N. Deterministic gates all green: `typecheck`, `lint`
(0 err), `unit 912/912`, `integration` scaling-lock ✓ (3.8–4.5×),
warp-churn integration 5/5.

**Why it must not merge:** it removes the documented load-bearing
chapter-2 Phase C re-sim, so drones are no longer tick-forward-
extrapolated during reconcile — likely a **lockstep regression**
(per-snapshot drone snap). The `feel-test-lockstep` canary failed under
the change (`swarmSnapP50 24.4`, threshold 15) **but** the mandatory
baseline-in-same-env check showed committed HEAD failing *worse* (25.2)
— the marathon-loaded box is noise-pegging p50, so that reading is
environmental, not proof of regression. It is also **not proof of
safety**. The authoritative canary needs a **quiet host / CI**, and
because this path is documented-load-bearing that quiet-host canary is a
**hard merge gate**.

## 6. The fork for tomorrow (pick one before coding)

All options keep the player replay O(ticksAhead); they differ in how
drone lockstep fidelity is spent. All require the quiet-host canary.

- **A. Relevance-culled re-sim (recommended).** Tick-accurately re-sim
  only drones that matter (near the player / recently large-corrected /
  on a collision path); dead-reckon (cheap extrapolation) the stable
  far majority. Cost O(k × ticksAhead), k ≪ N. Preserves lockstep where
  it's visible; scales because most of 500 are far. Moderate complexity;
  needs a relevance predicate + the canary.
- **B. Cheaper uniform forward model.** Replace per-replay-tick
  `HostileDroneBehaviour.tick` with analytic dead-reckon for ALL drones
  during replay (keep full AI only in the per-frame live loop).
  O(ticksAhead). Simple; uniformly lower fidelity — canary decides if
  `swarmSnapP50` stays < 15.
- **C. Keep the branch's freeze + tune the existing correction
  channel.** Smallest code (already built); rely on the binary-swarm
  packet + `_droneRenderOffsets` spring to hold `swarmSnapP50` < 15
  without per-tick re-sim. Uncertain; pure tuning against the canary.

## 7. Concrete next steps (in order)

1. **Get a quiet-host/CI `feel-test-lockstep` reading**, both on
   committed `main` (baseline) and on `fix/reconciler-replay-scaling`.
   Run: `CI=1 pnpm e2e --project=chromium tests/e2e/feel-test-lockstep.spec.ts --reporter=line`
   on an unloaded machine (or CI). This is the gate that decides whether
   Option C is even viable and quantifies the real lockstep cost of the
   freeze.
2. **Pick a fork** (§6) based on that number + the user's
   fidelity/scale preference.
3. Implement on the branch; keep `tests/integration/reconcilerReplayScaling.test.ts`
   green (it locks the scaling win) **and** add/keep the canary as the
   lockstep gate. Per invariant #13 the lock already fails-first if the
   scoping is reverted.
4. **File the `pnpm bench` infra ticket** — vitest 2.1.9 benchmarking is
   a no-op (0 samples for all benches incl. pre-existing). Invariant #8
   lists `pnpm bench` as a green bar; it currently proves nothing.
5. Only merge when: chosen fork green on deterministic gates **and** a
   quiet-host canary shows `swarmSnapP50 < 15` (not loaded-host noise).
   Then update `src/client/CLAUDE.md` "Drone prediction is reconciled"
   + `docs/architecture/ai-lockstep.md` Phase C (the mechanism changed)
   + this doc's status.

## 8. Key files / how to run

- Branch: `git switch fix/reconciler-replay-scaling` (main is clean).
- Change: `src/core/physics/World.ts` (`unlockBody`),
  `src/core/prediction/Reconciler.ts` (`freeze` param),
  `src/client/net/ColyseusClient.ts` (passes freeze, drops re-sim).
- Scaling lock: `pnpm test:integration tests/integration/reconcilerReplayScaling.test.ts`
  (prints the unfrozen-vs-frozen table + speedup).
- Lockstep canary: `tests/e2e/feel-test-lockstep.spec.ts`
  (`swarmSnapP50 < 15` — **run on a quiet host**).
- Diags referenced: `diag/captures/2026-05-16T19-31-00-012Z-q272do`
  (churn, fixed), `…20-03-36-048Z-a3f5na` (this scaling stall).

## 9. Resolution (2026-05-17) — Option A shipped (dead-reckon, NOT freeze)

**Decision.** The §6 fork was put to the user; they chose **A —
relevance-culled re-sim**. Critically, Option A is *dead-reckon the FAR
majority*, **NOT freeze** — the §5 branch's blanket-freeze WIP (`814d7bc`)
was *superseded and reverted*, not built upon (see "Clean-merge" below).

**What shipped.**

- [`src/core/prediction/droneRelevance.ts`](../../src/core/prediction/droneRelevance.ts)
  — pure `partitionDronesByRelevance` + `DRONE_RELEVANCE_RADIUS`
  (`HITSCAN_RANGE × 2`, catalogue-derived) / `DRONE_SNAP_RELEVANCE_U`.
- [`src/core/ai/AiController.ts`](../../src/core/ai/AiController.ts) —
  `tickOnly(ids, …)` (O(k) subset re-sim) sharing a private `runEntity`
  with the unchanged all-ticks `tick`. **A predicate-on-`tick` was built
  first and rejected** — it culls the brain work but still iterates all N
  per replayed tick, so it stays O(ticksAhead × N) (17.2 ms / 1.93×-in-N).
  `tickOnly` iterating the NEAR set is the genuine O(k) fix.
- [`src/client/net/ColyseusClient.ts`](../../src/client/net/ColyseusClient.ts)
  — partitions `_aiRegisteredIds` by the `droneSeed` anchor pose +
  `isEntityHostileToPlayer` + a cheap `_droneLastSnapDist` stashed at the
  already-computed `swarm_snap_diagnostics` site; runs
  `tickClientAi(NEAR)` in `perReplayTick`. **No freeze** — `replaySeed`
  re-anchors every in-interest drone and the unfrozen replay `world.tick()`
  integrates the FAR majority ballistically (dead-reckon). The live
  per-frame `tickClientAi()` is unchanged.
- **`Reconciler.ts` / `World.ts` are byte-identical to `main`** — Option A
  needs no `freeze` param and no `World.unlockBody`; those `814d7bc`
  additions (for the rejected blanket approach) were reverted.

**The freeze→dead-reckon course-correction (the load-bearing finding).**
FAR drones were *first* implemented as **frozen** (`lockBody` for the replay
loop, mirroring `814d7bc`). The quiet-host canary (CPU ~2–11 %, low GC)
caught a real regression that *every deterministic gate passed*:

| `feel-test-lockstep` (baseline-in-same-env, quiet host) | `main` | Opt-A **freeze** | Opt-A **dead-reckon** |
|---|---|---|---|
| `swarmSnapP50` (gate < 15, the chapter-2 lock) | 11.09 ✓ | **20.40 ✗** | **1.61 ✓** |
| `swarmSnapP99` (< 100) | 24.58 | 62.25 | 9.56 |
| `swarmAngleP99` (< 1.0) | 0.105 ✓ | 1.227 ✗ | 0.0995 ✓ |
| `swarmAngvelP99` (< 0.15) | 0.617 ✗ | 0.711 ✗ | 0.581 ✗ |

A *frozen* FAR drone is held at the `ackedTick` anchor for a whole snapshot
interval while `_droneSnapshotAnchored` gates off the binary correction —
so it accumulates the entire missed motion and snaps it on the next
snapshot. **Dead-reckon** (don't freeze; let the body integrate
ballistically from the `replaySeed` anchor) keeps the linear motion; only
the AI *curve* over the window is lost, which for a stable far drone is
tiny. Result: dead-reckon Option A is not just non-regressing — it is **7×
better than `main`** on `swarmSnapP50` (1.61 vs 11.09), because ballistic
extrapolation from the authoritative anchor beats `main`'s
predicted-player-input re-sim for stable far drones, while NEAR drones keep
full re-sim. `swarmAngvelP99` fails on **`main` too** (0.617) — a
pre-existing desktop-Playwright environmental artifact (Opt-A 0.581 is
marginally *better*), explicitly *not* an Option-A regression per the
baseline-in-same-env rule.

**Measured scaling (headless, `tests/integration/reconcilerReplayScaling.test.ts`,
N=500 / ticksAhead=48, NO freeze):**

| path | ms | vs all-brain |
|---|---|---|
| all-brain re-sim (pre-fix / `main`) | ~42 | 1.0× |
| **Option A culled (k=20 NEAR, FAR dead-reckon)** | **~12.5** | **~3.4×** |
| zero-brain floor (k=0, all dead-reckon) | ~10.4 | — |

Culling the expensive brain re-sim is the win (~3.4×); FAR dead-reckon adds
only ~1.2× the zero-brain floor (cheap O(N) body integration that `main`
already paid). The lock asserts **ratios** (≥2.5× vs all-brain; culled ≤
2.0× the zero-brain floor) — host-robust; reverting the cull collapses it
(invariant #13).

**Gates (final, clean state).** typecheck ✓ · lint 0-err ✓ · unit
926/926 ✓ (incl. back-compat `AiController.test.ts` + `Reconciler.test.ts`
12/12 after the revert) · integration scaling lock ✓ (3.4×) · server-boot
smoke ✓ · quiet-host `feel-test-lockstep` `swarmSnapP50` 1.61 ≪ `main` 11.09
≪ 15.

**Clean-merge.** `814d7bc` (blanket-freeze WIP, "DO NOT MERGE") is dropped
from history (soft-reset to `main`); the merged change is a single coherent
Option A on top of `main`, with `Reconciler.ts`/`World.ts` unchanged from
`main`.

**Follow-up (separate, not blocking).** `pnpm bench` emits **0 samples** for
ALL benches under vitest 2.x — invariant #8 lists it as a green bar but it
currently proves nothing. Tracked in `docs/LESSONS.md` 2026-05-17; the
`performance.now()` ratio lock is the de-facto perf gate meanwhile.

### In-pack completion — per-snapshot re-sim BUDGET (2026-05-17, diag m6rq2t)

Option A's radius cull deferred one case: **the player inside the bot
pack**. There NEAR≈ALL (every drone hostile/close), the cull gives zero
relief, and per-snapshot reconcile is O(replayWindow × N). On-device that
was the *progressive combat-lag spiral*: as the client's snapshot-handle
interval slows (33→91 ms over a fight), the replay window grows → work
grows → handling slows → rubber-band worsens until the player can't fight
and dies. (The disconnect/respawn the capture also showed was a
*downstream symptom*, not the bug — the user's "the lag was before death
and built progressively" correctly falsified an earlier respawn theory.)

Fix completes the relevance model with a hard per-snapshot **re-sim
budget** `DRONE_RESIM_BUDGET` (`droneRelevance.ts`, default 12):
`partitionDronesByRelevance` keeps only the **K most-relevant** (hostile,
then closest, deterministic id tiebreak) in NEAR; the overflow demotes to
FAR (dead-reckon — Option A established that's visually fine for
non-engaged drones). Per-snapshot brain cost → O(replayWindow × K), K
bounded regardless of pack size → spiral broken, scales to the 500 target.
**Default-ON** (an unbounded in-pack re-sim *is* the bug); **byte-identical
when NEAR ≤ K**, so steady-state + chapter-2 lockstep + the
feel-test-lockstep canary are untouched (canary room = 10 drones < budget
12, provably unaffected). Production needs **no callsite change** (sole
caller omits `maxResim` → default). Locks: `droneRelevance.test.ts` (k-cap
unit) + `reconcilerReplayScaling.test.ts` in-pack ratio lock (≥2× win vs
the all-near spiral; bounded brain premium over the zero-brain floor — NOT
"flat in N": body integration is O(N), on `main` too — asserting flatness
is wrong, same host-robust contract as Option A's).
