# Reconciler replay scaling — WIP handoff (2026-05-16 → tomorrow)

> **Status:** investigation + measurement **complete**; a candidate fix is
> implemented and green on every deterministic gate but is **NOT merged**
> and **must not be merged as-is** — it removes a documented load-bearing
> chapter-2 lockstep path (invariant #12). It lives on branch
> **`fix/reconciler-replay-scaling`** (off `main` @ `e2ab0b4`). `main` is
> clean and shippable (it has the separately-merged warp-churn fix).
>
> **This is an architecture decision, not a code-finish task.** Read this
> doc, then pick a direction (the fork in §5) before writing more code.

---

## 1. What shipped vs what's pending

| Item | State |
|---|---|
| **Living-world warp-churn fix** (`playerStickyMs` occupancy hysteresis) | ✅ **Merged to main** (`89d009e` → merge `e2ab0b4`). Shipped, done. |
| **Reconciler replay scaling** (this doc) | 🟡 **WIP on `fix/reconciler-replay-scaling`**. Measured + implemented + deterministically green; blocked on a lockstep/scale architecture decision + a quiet-host canary. |

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
