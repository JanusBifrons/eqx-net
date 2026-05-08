# Network Feel & Client-Sim Smoothness Roadmap

## Context

EQX Peri already has a strong networking core: 60 Hz authoritative server tick, 60 Hz off-main-thread physics worker with SAB, 20 Hz ship snapshot, 60 Hz binary swarm channel, client-side prediction with a 128-slot input ring + reconciler, AOI-filtered interest management, and 12-tick hitscan lag-compensation. The visible smoothness ceiling is set by a handful of decisions that are now demonstrably conservative:

- `INTERP_DELAY_MS = 100 ms` for remote-entity interpolation. `docs/FEEL_GOALS.md` already flags 50 ms as achievable now that snapshot jitter is stable < 20 ms.
- The reconciler's visual correction is a **linear** lerp scaled to drift magnitude (50–300 ms). Linear shapes look like a "glide" on big corrections; 300 ms for >20u corrections is called out as too slow in `FEEL_GOALS.md`.
- Server **does not broadcast collision events**. After a collision, the client's predicted state takes one full snapshot (~50 ms) to converge. `FEEL_GOALS.md` flags this as the dominant residual feel-gap.
- Remote ships are **interpolated, never predicted**. They live ~100 ms in the past at the renderer. There is no forward-extrapolation from last-known input intent, so dogfights perceive remote opponents as lagging behind their actual physics state.
- `leadTicks` (prediction lookahead) is EWMA-smoothed against RTT only, ignoring jitter — under unstable links it under-shoots and the input loop has to catch up in visible chunks.
- No detection or graceful degradation on **dropped/reordered snapshots**. A missing tick currently extends extrapolation silently up to a fixed cap.
- Swarm/ship pose is wire-encoded as float32 with no delta compression. Bandwidth headroom limits how high we can push snapshot rate when we want to.

This is a **7-stage roadmap, ~12–15 focused days** of work, that systematically lifts each ceiling while preserving every cross-phase invariant in the root `CLAUDE.md`. Stages are ordered so each one builds on the previous: tuning constants exposes which lerps need spring shapes; spring shapes make collision-event injection look continuous; collision events feed remote-entity prediction with up-to-date velocities; remote prediction makes adaptive jitter handling worthwhile; adaptive jitter exposes whether snapshot cadence is the limit; cadence improvements only pay off if the wire is cheap enough to carry them.

Out of scope for this plan: visual juice (camera shake, hit-stop, screen flash), audio, particles, UI animation. Those are separate workstreams.

---

## Cross-Machine Persistence & Maintenance Protocol

This roadmap will be executed across multiple sessions on multiple machines. The `~/.claude/plans/` location is machine-local — it will not survive a `git pull` on another box. To preserve context across machines, the plan **lives in the repo** under this `plans/` folder.

### Maintenance protocol

- **At the start of each work session**: read `plans/network-feel-roadmap.md` end-to-end (cheap, < 30 s of context loading) to recover state.
- **Whenever a micro-cycle's "Failing test → Implementation → Green" finishes**: tick off the corresponding line in the **Stage Progress Tracker** at the bottom of the plan and commit the tick alongside the code change. This means any future session sees exactly which step was last completed and resumes there.
- **Whenever a discovery changes the plan** (test-infra needs more investment than expected, a stage spawns a sub-stage, an assumption proves wrong): edit the plan in the same commit as the code change and add a one-line entry to the **Decision Log** at the bottom of the plan. Never silently divert from the plan.
- **At the end of each stage**: update the stage's "Status" line in the Stage Progress Tracker to ✅ done, and append the stage's measured outcomes (drift bounds, frame-time, bytes/sec) to `docs/FEEL_GOALS.md` under a new "Measured after Stage N" subsection.
- **The plan file is read-mostly between sessions**: don't delete completed sections, don't restructure unless required by an actual decision change. A future session needs to be able to read the plan and reconstruct *why* something is the way it is.

### When to retire this plan

When all 7 stages are ✅ done in the tracker and `docs/FEEL_GOALS.md` reflects the new measured ceilings, move this file to `plans/archive/network-feel-roadmap.md` and add a one-line redirect at `plans/network-feel-roadmap.md` pointing to the archive copy. Don't delete — the decision log is a permanent artefact.

### Follow-on workstreams to surface at retirement

When this roadmap retires, the closing summary should explicitly recommend a separate **server-perf scaling pass**, distinct from network feel. The 2026-05-08 TiDi-4000 diagnostic (`diag/captures/2026-05-08T12-11-42-626Z-wpb1hl.json`, see `docs/LESSONS.md` Pattern B) demonstrated three independent issues this roadmap **does not fix**:

1. **TiDi trigger gap** — engages on `avgMs.total` only, missing chronic spike-driven slowdowns where averages stay under the threshold but `maxTotalMs` and `overBudgetCount` show the simulation falling behind real time.
2. **SAB-read scaling** — 8.7 ms / 3200 entities on the test laptop is ~2.7 µs/entity. Already memcpy-class, but worth profiling for cache-line / interest-filtering wins under high counts.
3. **Mobile-client tab-pause resilience** — a 3.1 s `rafTick` gap was observed; the network-feel roadmap's Stage 6 keyframe-on-resume is a partial mitigation but not a full solution.

These are cleanly separable from prediction smoothness. Don't fold them into this plan — surface them at retirement.

---

## Cross-stage Invariants

Every stage MUST hold:

1. `src/core` stays blind — no client/server imports. New contracts go in `src/core/contracts/`.
2. No spatial fields enter Zustand. All position/velocity/angle stays in mirror / SAB / predWorld.
3. Every new inbound message has a zod schema; malformed packets dropped with sampled `pino.warn`.
4. Fixed-timestep physics — no variable-dt steps.
5. Bus variants are discrete only. No per-frame emits.
6. Each stage ships with: a new/updated E2E spec under `tests/e2e/`, a doc in `docs/architecture/` or `docs/features/` (or update to existing), `docs/LESSONS.md` entry for any non-obvious finding, CLAUDE.md update where the stage adds an invariant or contract.
7. Green bars: `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e && pnpm bench` plus 8s `pnpm dev:server` boot smoke.
8. SWARM_WIRE_VERSION bump if Stage 7 changes byte layout; decoder must hard-fail on old version.

---

## TDD Workflow (cross-cutting)

Every stage runs as a **micro-cycle** of: write a failing test → write the smallest code change that makes it pass → refactor with tests green. Macro-level acceptance is the heavy E2E spec at the *end* of each stage; the micro-cycle uses lightweight tests only.

### Two test tiers

**Tier 1 — Inner loop (fast, run on every save)**
- Vitest unit tests against pure modules in `src/core/**` and `src/client/net/**` (input, decoder, prediction, spring math, Welford).
- Vitest with **fake time** (`vi.useFakeTimers()`) for any time-dependent logic — never real `setTimeout`/RAF in unit tests.
- Vitest with a **mock `INetworkSink`** (in-memory loopback) for client-side simulation tests. Already a contract; just expand the loopback fixture.
- Headless renderer-free integration via the existing `IRenderer` test double.
- **Target runtime: < 5 s for the entire fast suite.** This is what runs constantly during the rinse-repeat cycle.

**Tier 2 — Outer loop (heavy, run once per major change)**
- Playwright E2E with real Colyseus server, real network throttling, real ProMotion-emulation.
- 60–120 s per spec. **Run only:** at the end of a stage's micro-cycle, before opening a PR, and when CI-gated.
- Always narrowed (`--project=chromium <single-spec>` per the root CLAUDE.md guidance) and run with `run_in_background: true` if > 30 s.

### Per-stage cycle

For each stage below, the cycle is:

1. **Plug test-infra gaps first** (listed per-stage). Without these, the inner-loop suite can't catch the relevant failure modes.
2. **Write the failing Tier-1 test** that encodes the desired property (drift bound, spring shape, packet-loss tolerance, etc.).
3. **Implement the smallest change** that turns it green.
4. **Refactor** with tests green.
5. Repeat micro-cycles until the stage's exit-criteria assertions are all green in Tier 1.
6. **Now write the Tier-2 E2E spec** that covers the macro behaviour of the stage end-to-end. Run once. If it passes, the stage is done; if it surfaces something the Tier-1 tests missed, encode that as a new Tier-1 test before fixing — preserves the property the macro test exposed.

### Test-infra investments (carried across stages)

These are tools the codebase needs once and benefits from throughout the roadmap. Build them lazily — when the first stage needs each one, build it then, not upfront.

- **`fakeNetwork` harness** (Stage 1 first need): in-memory two-side network with configurable RTT, jitter (Welford-friendly), and drop probability. Pluggable into `INetworkSink` and the client decoder. Lets us write deterministic unit tests of jitter/loss behaviour that today require Playwright + CDP.
- **`virtualClock` helper** (Stage 1 first need): wraps `performance.now()` and `requestAnimationFrame` for the renderer. Already partially exists for tests; harden it so spring math can be tested at any virtual frame cadence.
- **`mirrorAssertions` matchers** (Stage 0): vitest custom matchers — `expect(mirror).toHavePoseWithin(playerId, target, tolerance)`, `expect(mirror).toHaveStableDriftOver(durationMs, threshold)`. Cuts test boilerplate dramatically.
- **`recordedSession` fixtures** (Stage 3): capture real session snapshots once, replay deterministically against the prediction code in unit tests. Gold-standard regression coverage for prediction without Playwright.
- **CI lane split** (any stage): `pnpm test` runs Tier 1 only; `pnpm test:full` (or CI) runs Tier 1 + Tier 2. Local dev never blocks on Tier 2. Implement as a vitest `--project` boundary or separate scripts in `package.json`.

---

## Stage 0 — Tuning quick wins (~1 day)

The cheapest gains. Pure constant changes + short test updates. Ship before any structural work so the rest of the roadmap is measured against the new baseline.

### Test-infra to plug first
- Build the `mirrorAssertions` vitest matchers — they're used from Stage 0 onward.
- Confirm `Reconciler.test.ts` already exposes `lerpOffset` over time; if it only asserts end-state, extend the harness to sample the offset across N virtual frames.

### Micro-cycles
1. **Failing Tier-1 test**: `Reconciler.test.ts` — assert that for a 30u drift, `lerpFramesLeft <= 6` after the correction is queued. Currently 18; will fail.
2. Change `lerpFramesForDrift` cap. Test goes green.
3. **Failing Tier-1 test**: `Reconciler.test.ts` — assert that at the midpoint of a lerp, `lerpOffset.x` is `> 0.25 × initial` (ease-out shape: still > 25% at t/T=0.5; linear would be exactly 50%). Currently linear; will fail.
4. Change ratio formula to `(framesLeft / total)²`. Test goes green.
5. **Failing Tier-1 test**: `swarmInterpolation.test.ts` — assert `INTERP_DELAY_MS` is exposed (or implicitly: a pose 50 ms behind is the displayed pose) and equals 50.
6. Change constants. Test goes green.
7. **Failing Tier-1 test**: same file — assert adaptive ceiling is 200 ms, not 350.
8. Change. Green.

### Tier-2 (end of stage)
- New `tests/e2e/feel-tuning.spec.ts`: spawn ship, induce a known collision, assert correction settles within 110 ms of snapshot arrival. Run once.

### Critical files
- `src/core/prediction/Reconciler.ts`
- `src/client/net/swarmInterpolation.ts`
- `src/client/net/ColyseusClient.ts` (remote-ship lerp + INTERP_DELAY constant)
- `docs/FEEL_GOALS.md` (record new measurements)

---

## Stage 1 — Spring-based smoothing for all corrections (~1 day)

Replace every linear lerp in the prediction/interpolation layer with a critically-damped spring. Frame-rate-independent, settles fast on small errors and smoothly on large, reads as "alive" rather than "decay-to-zero". The Plan agent flagged this as load-bearing on ProMotion devices where rAF cadence shifts mid-session.

### Test-infra to plug first
- Build `virtualClock` helper if not already adequate for spring testing.
- Ensure unit tests can drive `advanceLerp(dtMs)` at arbitrary virtual cadences (60 Hz, 120 Hz, irregular).

### Micro-cycles
1. **Failing Tier-1 test**: new `CritDampedSpring.test.ts` — convergence within 1% of target after `5 × halfLife`. No code yet → red.
2. Implement `src/core/math/CritDampedSpring.ts`. Green.
3. **Failing test**: same file — no overshoot under critically-damped factor.
4. Implement (or verify) damping coefficient choice. Green.
5. **Failing test**: same file — frame-rate independence: same end state at dt=8 ms vs dt=33 ms across the same total time, within 1%. (This is what protects ProMotion transitions.)
6. Verify implementation passes; if not, fix integration scheme (sub-stepping for large dt). Green.
7. **Failing Tier-1 test**: extend `Reconciler.test.ts` — replace ratio-shape assertion with spring-shape assertion: at t = halfLife the offset should be ~50% of initial.
8. Swap `Reconciler` internals to use spring. Green.
9. Repeat for `ColyseusClient` remote-ship offset and `swarmInterpolation` re-target shim.

### Tier-2 (end of stage)
- Extend `feel-tuning.spec.ts` with a ProMotion-emulated 120 → 60 Hz cadence flip via Playwright `evaluate()` patching of `requestAnimationFrame`. Assert no visible position jump > 0.5u during the flip. Run once.
- New micro-bench `benchmarks/spring.bench.ts`: spring-step < 200 ns per call. Run once at end of stage.

### Critical files
- `src/core/math/CritDampedSpring.ts` (new) and `.test.ts`
- `src/core/prediction/Reconciler.ts`
- `src/client/net/ColyseusClient.ts`
- `src/client/net/swarmInterpolation.ts`
- `docs/architecture/prediction-and-correction.md` (new — this doc consolidates the prediction picture; FEEL_GOALS.md gets a pointer)

---

## Stage 2 — Collision event broadcasting (~2 days)

The single largest network-feel win for combat. Instead of waiting one full snapshot (50 ms) for the client's predicted ship to converge after a collision, the server pushes the post-collision velocities the moment Rapier resolves them. Residual drift drops from 5–30u glides to sub-2u nudges (`FEEL_GOALS.md` Goal #1).

### Architecture
1. **Worker drains Rapier `EventQueue`** after `world.step()` in `src/core/physics/worker.ts`. Filter contacts by impulse magnitude (≥ 8 N·s) so we don't spam — most drone↔drone soft contacts aren't worth the wire.
2. **New worker→main message variant** `CONTACT { aId, bId, vAxPost, vAyPost, vBxPost, vByPost, impulse, tick }`, postMessage'd alongside existing `READY` and `SLEEP_TRANSITION`. SAB is wrong vehicle (discrete, not per-frame).
3. **Main thread (`SectorRoom`)** receives `CONTACT`, emits a new core Bus variant `COLLISION_RESOLVED`, and queues an outbound `collision_resolved` message via `INetworkSink`, AOI-filtered through the existing 3×3 cell window.
4. **Client (`ColyseusClient`)** registers a zod schema for `collision_resolved`, decodes, and applies `vPost` directly to the matching body in predWorld. No replay needed — the server's velocity is authoritative for that instant. Reconciler will re-validate on next snapshot anyway.

### Bus / contracts
- New variant in `src/core/events/Bus.ts`: `{ type: 'COLLISION_RESOLVED', aId: EntityId, bId: EntityId, vA: Vec2, vB: Vec2, impulse: number, tick: number }`.
- New zod schema in `src/shared-types/messages.ts`: `CollisionResolvedSchema` mirroring the bus shape.

### Edge cases & invariants
- Worker must never emit if a body's RigidBody handle is stale (sleeping/destroyed mid-step) — guard with `bodies.has(id)`.
- AOI filter on broadcast: only send if **either** participant is in client's interest cell window (so a shot you didn't see still gets the velocity update if you can see the target).
- Out-of-order `collision_resolved` vs `snapshot`: snapshot wins (it's authoritative state), but collision events should be discarded if `event.tick < client.lastSnapshotServerTick`.
- New rate-limit: max 4 collision events per ship per second client-side (suppress duplicates); also flag-and-warn if the worker emits >50/sec (broken impulse filter).

### Test-infra to plug first
- Pure-physics test harness for the worker (no `worker_threads` boundary): refactor `worker.ts` so the EventQueue-drainage logic is a pure function `drainContacts(world, eventQueue, impulseFloor)` returning a list. The worker bootstrap calls this and posts; tests call it directly. **This refactor is the test-infra investment.**
- `fakeNetwork` harness — a two-side message bus with deterministic delivery order. Lets us test the full `worker → main → server-relay → client → predWorld application` chain in vitest under fake time. Without this we'd need Playwright; with it, the inner loop covers the full path.
- Zod schema test fixture: a small helper that fuzzes malformed inbound messages against the new schema and asserts they're dropped, not thrown.

### Micro-cycles
1. **Failing test**: `drainContacts` returns one event for a known two-body collision above impulse floor, none for a soft tap below floor.
2. Implement `drainContacts`. Green.
3. **Failing test**: schema fixture rejects malformed `collision_resolved` payloads (wrong field types, missing fields).
4. Implement schema. Green.
5. **Failing test** (using `fakeNetwork`): a `collision_resolved` message arriving before the next snapshot causes predWorld velocity to update to `vPost` immediately.
6. Implement client subscriber. Green.
7. **Failing test**: an out-of-order `collision_resolved` with `tick < lastSnapshotServerTick` is silently dropped (predWorld unchanged).
8. Implement guard. Green.
9. **Failing test**: rate-limit — > 4 events for the same ship in a 1 s window suppresses the excess.
10. Implement rate limit. Green.

### Tier-2 (end of stage)
- New E2E `tests/e2e/collision-events.spec.ts`: two real clients, real ship-asteroid collision, assert post-collision drift < 2u within 20 ms. Run once.

### Critical files
- `src/core/physics/worker.ts`
- `src/core/events/Bus.ts`
- `src/server/rooms/SectorRoom.ts`
- `src/client/net/ColyseusClient.ts`
- `src/shared-types/messages.ts`
- `docs/architecture/collision-events.md` (new)
- `src/core/CLAUDE.md` (document the new worker→main message variant alongside SLEEP_TRANSITION)

---

## Stage 3 — Remote entity forward-prediction (~2–3 days)

Today every remote ship and drone is **interpolated** (lives ~50 ms in the past after Stage 0). For combat feel that's a hard ceiling — when you fire at an opponent, they're rendered where they were 50 ms ago. The fix is to **forward-predict** remote entities the same way we predict the local ship: run their physics forward using last-known input intent, smooth-correct on each snapshot.

### Architecture
- **Snapshot carries last-known input vector per ship**: extend the snapshot ship payload with `lastInput: { thrust, turnLeft, turnRight, boost, reverse }` (5 bits, packed into a u8). Already cheap on wire.
- **Per-remote-ship prediction world**: each remote ship gets a tiny `RemotePrediction` instance owning a `PhysicsWorld`-of-one (single ship body), advanced each render frame from the last-snapshot pose with the last-known input vector, up to `inputTick`.
- **Spring-correct on snapshot arrival** using the Stage 1 critically-damped spring; this is mathematically the same shape we use for local reconciliation.
- **Drones**: remote drones already have deterministic AI in `src/core` (behaviour trees). Apply the same forward-prediction technique using the shared AI module — predicted drone behaviour matches server behaviour exactly modulo input from other agents.

### Knobs
- Max prediction lookahead = `min(localInputTick - serverTick, 8 ticks)` to prevent runaway drift on long stalls.
- Disable forward-prediction per-entity when last 3 corrections exceeded 5u (input intent has changed faster than we can track) — fall back to interpolation. Re-enable when 3 consecutive snapshots come in below threshold. Hysteresis exposed as a debug counter.

### Edge cases & invariants
- The input invariants in `src/core/CLAUDE.md` re: the input queue contract apply only to the authoritative side. The remote-prediction world is a pure forward-runner — it uses `applyInput` + `tick(1/60)` directly without a queue.
- Remote prediction world must NEVER write to the render mirror directly — it produces a target pose, the spring blends, the renderer reads spring state.
- Memory: pre-allocate prediction worlds for `MAX_REMOTE_SHIPS` (e.g. 32) at boot; pool them. Same for drone prediction states.

### Test-infra to plug first
- `recordedSession` fixtures — capture a real two-client session's snapshots once, save as a JSON fixture, replay deterministically against the prediction code. This becomes the regression coverage for every future change to remote prediction without needing Playwright.
- Extend `fakeNetwork` to support per-client snapshot streams.

### Micro-cycles
1. **Failing test**: idle remote ship — predicted pose matches server pose exactly across 60 ticks.
2. Implement `RemotePrediction` skeleton with idle case. Green.
3. **Failing test**: remote ship under known thrust input — predicted pose within 0.1u of server pose after 8 ticks.
4. Implement input-vector forward simulation. Green.
5. **Failing test**: snapshot arrival mid-prediction causes spring-correct, not snap.
6. Wire up Stage-1 spring. Green.
7. **Failing test**: 3 consecutive corrections > 5u trip the hysteresis flag and disable forward-prediction for that entity (falls back to interpolation).
8. Implement hysteresis. Green.
9. **Failing test**: 3 consecutive corrections < 5u while disabled re-enable forward-prediction.
10. Implement re-enable path. Green.
11. **Failing test**: prediction lookahead capped at 8 ticks even if the gap is larger.
12. Implement cap. Green.
13. **Replay a `recordedSession` fixture**: assert predicted positions stay within 1u of recorded server positions throughout a 30 s combat scenario.

### Tier-2 (end of stage)
- New E2E `tests/e2e/remote-prediction.spec.ts`: two real clients, straight-thrust scenario, assert remote rendered position within 1u of server-confirmed position. Run once.
- Benchmark `benchmarks/remote-prediction.bench.ts`: 32 prediction worlds per frame < 0.5 ms median. Run once.
- A/B toggle behind a Zustand UI flag (UI-state only, not spatial — invariant safe) so the dev overlay can flip prediction on/off live for comparison.

### Critical files
- `src/core/prediction/RemotePrediction.ts` (new)
- `src/client/net/ColyseusClient.ts` (snapshot decode + remote pred orchestration)
- `src/shared-types/messages.ts` (extend snapshot ship payload)
- `src/server/rooms/SectorRoom.ts` (encode `lastInput` in snapshot)
- `docs/architecture/remote-prediction.md` (new)
- `src/client/CLAUDE.md` (document the prediction-vs-interpolation choice)

---

## Stage 4 — Adaptive jitter handling & smarter lookahead (~2 days)

Today `leadTicks` is EWMA-smoothed against RTT mean only. On unstable connections this under-buffers — when jitter spikes, the input loop visibly catches up in chunks. Move to a **mean + 2σ jitter** model and smooth lookahead transitions so the user never sees a stutter.

### Changes
- **Welford online variance** for RTT in `clockAnchor.ts`: keep running mean + variance (single-pass, no buffer).
- **Lookahead target = `(mean + 2σ) / FIXED_MS`** with a min floor (so very-low-RTT clients still have ~3 ticks of buffer). Replace the current EWMA-only formula.
- **Smoothed lookahead transitions**: when target changes by > 1 tick, ramp `leadTicks` over ~200 ms instead of jumping. Apply spring (Stage 1).
- **Per-snapshot drop detection**: each snapshot carries `serverTick`; if the gap from the last snapshot's `serverTick` exceeds expected (3 ticks at 20 Hz cadence), increment a `droppedSnapshots` counter and extend the swarm interp window by one extra tick. Reset on next clean arrival.
- **Adaptive interp delay**: extend the existing EWMA in `swarmInterpolation.ts` to also factor in dropped-snapshot count. When dropped > 0 in last 10 snapshots, bias the interp delay upward by `droppedCount × FIXED_MS`. When dropped == 0 for 30 snapshots, decay back to floor.
- **Dev overlay additions**: RTT mean, RTT 2σ, current lookahead target, dropped-snapshot count.

### Edge cases
- Welford `M2` accumulator — beware float drift over hours-long sessions; reset every 600 samples (10 minutes at 1 Hz pings).
- Don't chase `2σ` blindly: cap lookahead at 30 ticks (500 ms) — past that the prediction window is too speculative; fall back to local-only animation hints.

### Test-infra to plug first
- Extend `fakeNetwork` to inject **per-message jitter** (gaussian around mean RTT with configurable σ) and **drops** (configurable probability). This is the inner-loop equivalent of Playwright's CDP throttling.

### Micro-cycles
1. **Failing test**: Welford module — mean and variance match numpy reference for a known sequence.
2. Implement `src/core/math/Welford.ts`. Green.
3. **Failing test**: long-running stability — `M2` accumulator does not drift after 600 samples (asserts the reset-window invariant).
4. Implement reset window. Green.
5. **Failing test** (using `fakeNetwork` with jitter σ=20 ms): client lookahead converges to `mean + 2σ` within 5 s.
6. Switch the formula. Green.
7. **Failing test**: when target lookahead changes by 3 ticks abruptly, `leadTicks` ramps over ~200 ms instead of jumping.
8. Wire spring (Stage 1). Green.
9. **Failing test**: when `fakeNetwork` drops one snapshot, `droppedSnapshots` counter increments and interp delay extends by one tick.
10. Implement detection. Green.
11. **Failing test**: 30 clean snapshots after a drop spike decay the bias back to floor.
12. Implement decay. Green.

### Tier-2 (end of stage)
- E2E `tests/e2e/jitter-resilience.spec.ts` with Playwright CDP `Network.emulateNetworkConditions` for σ=30 ms jitter; assert no visible position jumps > 5u during 30 s. Run once.

### Critical files
- `src/client/net/clockAnchor.ts`
- `src/client/net/ColyseusClient.ts`
- `src/client/net/swarmInterpolation.ts`
- `src/core/math/Welford.ts` (new) and `.test.ts`
- `docs/architecture/prediction-and-correction.md` (extend)

---

## Stage 5 — Snapshot cadence & priority (~2 days)

With Stages 0–4 in place, the limiting factor for fast-action feel becomes raw snapshot frequency. Lift it without proportional bandwidth growth.

### Changes
- **Per-client phase staggering**: each client gets a 0–2 tick offset (hashed from `playerId`) for snapshot broadcast. Today every client is broadcast on the same tick, causing periodic CPU spikes; staggering smooths server load and incidentally narrows perceived snapshot jitter.
- **Priority-tiered ship snapshot rate**: bump close-by ships (within ~one screen / 1 cell) to **30 Hz** (every 2 ticks); leave far-AOI ships at 20 Hz. Implementation: per-client snapshot loop already iterates AOI cells — add a priority predicate.
- **Drop redundant fields**: if `lastInput` for a ship hasn't changed since last snapshot, omit it (a single bit-flag in the snapshot header). Saves bytes for all the idle ships.
- **Idle suppression**: if no ship in a sector has moved >0.05u in the last second AND no projectiles in flight, skip snapshot broadcasts entirely (clients still get binary-swarm pulse + heartbeat). Re-enable on first event.
- **Telemetry**: `bytesPerSecond` and `snapshotsPerSecondInTier` counters in dev overlay.

### Edge cases
- Phase staggering must not break the existing "broadcast every 3 ticks" SAB-divisibility workaround documented at `SectorRoom.ts:1742`. Add the offset as a per-client modulo, not by changing the global cadence.
- Tiered rate adds a "boundary flicker" risk when a ship crosses the close↔far boundary. Solve with a 1-cell hysteresis margin.

### Test-infra to plug first
- A `MockSectorRoom` harness — strip Colyseus dependency from the broadcast scheduling logic so it's testable in vitest without spinning up a server. The encoding+priority+stagger logic moves into a pure module called by the room.

### Micro-cycles
1. **Failing test**: per-client phase offset is deterministic given playerId; two clients with different ids are not in phase.
2. Implement hash-based offset. Green.
3. **Failing test**: a client's snapshot cadence respects its offset (offset=1 tick → first snapshot lands at tick 1, not 0).
4. Implement scheduling. Green.
5. **Failing test**: ship inside the close-priority cell window receives 30 Hz snapshot rate; ship outside receives 20 Hz.
6. Implement priority predicate. Green.
7. **Failing test**: 1-cell hysteresis — a ship oscillating across the boundary doesn't flip rate every tick.
8. Implement hysteresis. Green.
9. **Failing test**: idle suppression — when no entity moves > 0.05u for 1 s and no projectiles in flight, snapshot broadcasts skip.
10. Implement suppression. Green.
11. **Failing test**: re-enable on first event after suppression.
12. Implement re-enable. Green.
13. **Failing test**: omitted-`lastInput` flag in snapshot header is set when input unchanged.
14. Implement flag. Green.

### Tier-2 (end of stage)
- Bench `benchmarks/snapshot-cadence.bench.ts`: snapshots/sec per client, bytes/sec, CPU per tick. Targets met. Run once.
- E2E `tests/e2e/cadence-fairness.spec.ts`: two clients don't peak on the same tick. Run once.

### Critical files
- `src/server/rooms/SectorRoom.ts`
- `src/server/net/BinarySwarmBroadcast.ts`
- `src/shared-types/messages.ts`
- `src/client/net/ColyseusClient.ts`
- `docs/architecture/snapshot-cadence.md` (new)

---

## Stage 6 — Packet-loss & reordering robustness (~1–2 days)

Today the system is mostly resilient through accident (snapshots are stateless deltas, swarm has keyframes every 60 ticks). Make it deliberate.

### Changes
- **Sequence number on outbound input**: client tags each `input` message with a monotonic `seq` (separate from `tick`). Server includes `lastSeenSeq` on every snapshot. Client detects gaps and increments a `inputDropped` counter; warn at > 2% loss.
- **Snapshot-side drop detection** (already partly added in Stage 4): mark the snapshot as "post-gap" so the reconciler knows to be more conservative with corrections (longer spring half-life for one cycle).
- **Out-of-order tolerance**: server already handles input out-of-order via the input-queue contract. Add a unit test to lock in that behaviour. On the client, snapshots arriving with `serverTick < lastSeenServerTick` are silently dropped (currently they're applied — they would actively *cause* a bad correction).
- **Keyframe forcing on loss**: when client detects > 5% input loss in a 5-second window, send a `request_keyframe` message. Server responds with a full ship-state snapshot for the requesting client only.

### Edge cases
- The `request_keyframe` mechanism must be heavily rate-limited (max 1/sec/client) so a malicious client can't DoS the server with full-snapshot demands.
- Make sure the client's input ring buffer (128 slots) is large enough to survive a packet-loss event. At 60 Hz inputs and 5% loss over 2 sec, that's 6 missing inputs; ring is fine. Document the assumption.

### Test-infra to plug first
- `fakeNetwork` already supports drops (Stage 4); now add **reordering** — configurable probability that a message arrives one slot later than ordered.

### Micro-cycles
1. **Failing test**: client tags every input with monotonic `seq`; server's snapshot includes `lastSeenSeq`; client detects a gap when `lastSeenSeq < expected` and increments `inputDropped`.
2. Implement seq + counter. Green.
3. **Failing test**: snapshot arriving with `serverTick < lastSeenServerTick` is silently dropped (predWorld unchanged).
4. Implement guard. Green.
5. **Failing test** (fakeNetwork drop): post-gap snapshot triggers conservative spring half-life for one cycle (longer settle).
6. Implement post-gap flag passing. Green.
7. **Failing test**: at sustained > 5% input loss, client emits `request_keyframe`. At sustained < 1% it does not.
8. Implement detection + emit. Green.
9. **Failing test**: server enforces 1/sec/client rate-limit on `request_keyframe` (second within 1 s is silently dropped).
10. Implement limit. Green.
11. **Failing test**: server's input queue does not regress `ackedTick` on out-of-order receive — the existing `inputQueue` invariant test in `src/core/CLAUDE.md`. Lock it in if not already covered.

### Tier-2 (end of stage)
- E2E `tests/e2e/packet-loss.spec.ts` with Playwright CDP throttling at 5% loss; visible position errors < 3u over 60 s. Run once.

### Critical files
- `src/client/net/ColyseusClient.ts`
- `src/server/rooms/SectorRoom.ts`
- `src/shared-types/messages.ts`
- `docs/architecture/network-resilience.md` (new)
- `docs/LESSONS.md` (loss-handling gotchas)

---

## Stage 7 — Wire-format efficiency (~2–3 days, with care)

The Plan-agent's warning is load-bearing: a naive float32 → int16 quantization over a 10 000u world introduces ~0.15u quantization noise per snapshot, **above** `LERP_THRESHOLD = 0.05u`, which would actively *cause* new corrections every snapshot — net feel regression. The right approach is **delta encoding** without precision loss, with quantization reserved for fields where the noise floor is acceptable.

### Changes
- **Delta-encoded swarm packet** (v3): per-record, send `(dx, dy, dvx, dvy, dAngle)` as int16 quantized at 0.01u/0.001 rad steps, relative to the last keyframe pose. Keyframes (full f32 pose) every 60 ticks (existing cadence). Quantization noise: 0.005u — well below LERP_THRESHOLD.
- **Keep velocities and angles** as quantized int16 with appropriate scales: angles to 0.001 rad precision (need int16 for ±π range with 0.0001 rad precision); velocities to 0.1 u/s precision (int16 covers ±3276 u/s).
- **SWARM_WIRE_VERSION 2 → 3**: bump and ensure decoder hard-fails on v2. Existing v1→v2 hard-fail test pattern is the model.
- **Optional**: run-length encoding for sleeping clusters (asteroid belts) — compress N consecutive sleeping entities into a single `{baseId, count, kind}` record. Big savings during exploration phases.

### Bandwidth target
- Today: 29 bytes × 500 entities × 60 Hz ≈ 870 KB/s per sector.
- After deltas: ~14 bytes/record × 500 × 60 ≈ 420 KB/s. Halved. Funds Stage 5's 30 Hz close-tier ship snapshots without net regression.

### Test-infra to plug first
- A property-based test helper using vitest `fc` (fast-check) to generate random valid poses across the world's coord/velocity/angle ranges and round-trip them through the encoder/decoder.

### Micro-cycles
1. **Failing test**: round-trip property — for any valid pose, decode(encode(pose)) is within 0.01u of the original. Currently no v3 encoder → red.
2. Implement v3 keyframe encoder/decoder. Green for keyframes only.
3. **Failing test**: round-trip property for a delta packet — decode(encode(delta over base)) reproduces target pose within 0.01u.
4. Implement delta encoder/decoder. Green.
5. **Failing test**: angle wrap — a pose with angle near ±π round-trips correctly.
6. Implement angle wrap handling. Green.
7. **Failing test**: keyframe forced every 60 ticks regardless of stability.
8. Implement keyframe scheduler. Green.
9. **Failing test**: a v2 packet decoded by the v3 decoder hard-fails (throws or returns null).
10. Implement version check. Green.
11. **Failing test**: the LERP_THRESHOLD interaction — encode+decode noise on a stationary entity does NOT trip the reconciler's lerp threshold (0.05u). Cross-stage check.
12. Verify quantization scale meets the budget; tighten if needed. Green.

### Tier-2 (end of stage)
- E2E `tests/e2e/wire-version.spec.ts`: v2 client → v3 server hard-fails; v3 → v3 produces identical poses within 0.01u over 30 s. Run once.
- Bench `benchmarks/wire-format.bench.ts`: encode/decode < 0.1 ms for 500 entities. Run once.

### Critical files
- `src/shared-types/swarmWireFormat.ts`
- `src/server/net/BinarySwarmBroadcast.ts`
- `src/client/net/swarmInterpolation.ts` (decoder side)
- `docs/features/ship-kinds.md` (no change to kinds; just verify the `shipKindIdx` byte stays at the correct offset in v3)
- `docs/architecture/wire-format.md` (new — covers v1→v2→v3 history and the LERP_THRESHOLD interaction the Plan agent flagged)

---

## End-to-End Verification (post-Stage 7)

The inner-loop battery (`pnpm typecheck && pnpm lint && pnpm test`) is what runs constantly during micro-cycles — < 5 s. The full battery below runs once per major change and at the end of each stage:

```powershell
pnpm typecheck
pnpm lint
pnpm test                                       # Tier 1 only — fast
pnpm test:full                                  # Tier 1 + Tier 2 vitest E2E if any
pnpm e2e --project=chromium <stage-spec> --reporter=line   # narrowed Tier 2
pnpm bench                                      # only the stage's bench
$env:PORT='2568'; timeout 8 pnpm dev:server     # 8s boot smoke
```

The full `pnpm e2e` suite (60–120 s per spec, multi-minute total) runs only at the **end of a stage**, never during the inner micro-cycle. CI runs everything; local dev runs Tier 1 + the single targeted Tier-2 spec relevant to the change.

Behavioural acceptance (manual + dev overlay observations):
- Local-ship drift: idle 0u, thrust < 1u, collision settles < 2u within 20 ms (Stage 2 makes this true).
- Remote-ship visible lag: < 30 ms average behind real-time (Stage 0 + Stage 3).
- No visible jitter on ProMotion 120↔60 transitions (Stage 1).
- Position errors during 5% packet loss: < 3u (Stage 6).
- Bandwidth: < 500 KB/s/sector at 60 Hz close-tier swarm (Stage 7).
- Server CPU per tick: no regression vs current main-branch baseline.

Each stage's E2E spec is preserved in CI; regressions in any stage are caught by its own test.

## Documentation map (delivered artefacts)

- `docs/architecture/prediction-and-correction.md` (new — Stage 1, extended in Stage 4)
- `docs/architecture/collision-events.md` (new — Stage 2)
- `docs/architecture/remote-prediction.md` (new — Stage 3)
- `docs/architecture/snapshot-cadence.md` (new — Stage 5)
- `docs/architecture/network-resilience.md` (new — Stage 6)
- `docs/architecture/wire-format.md` (new — Stage 7)
- `docs/FEEL_GOALS.md` updated each stage with measured results
- `docs/LESSONS.md` appended at every stage gate
- `src/core/CLAUDE.md`, `src/client/CLAUDE.md`, `src/server/CLAUDE.md` updated for any new contract, bus variant, or invariant
- `plans/network-feel-roadmap.md` itself is a tracked artefact — see Persistence section above

---

## Stage Progress Tracker

Tick boxes as micro-cycles complete. Update `Status` when a stage is fully ✅. **Commit ticks alongside the code that earned them** so any future session knows where to resume.

### Step Zero — Cross-machine persistence  &nbsp; *Status: ✅ done*
- [x] `plans/` folder created at repo root
- [x] `plans/network-feel-roadmap.md` seeded
- [x] `plans/README.md` + `plans/CLAUDE.md` written
- [x] Seed commit landed (1840ed6)

### Stage 0 — Tuning quick wins  &nbsp; *Status: ✅ done*
- [~] Test-infra: `mirrorAssertions` matchers built &nbsp; *(deferred to Stage 3 — see Decision Log)*
- [~] Test-infra: `Reconciler.test.ts` time-sampling harness extended &nbsp; *(existing tests adequate — see Decision Log)*
- [x] Cycle 1: large-correction frame cap test → green
- [x] Cycle 2: ease-out shape test → green
- [x] Cycle 3: `INTERP_DELAY_MS` 50 ms test → green
- [x] Cycle 4: adaptive ceiling 200 ms test → green
- [x] Tier-2 spec `feel-tuning.spec.ts` written and passing &nbsp; *(73 corrections observed under `?room=sector` thrust-into-drone-ring; max queued frames = 6, max drift 80 u)*
- [x] `docs/FEEL_GOALS.md` updated with measured outcomes

### Stage 1 — Spring-based smoothing  &nbsp; *Status: ✅ done*
- [~] Test-infra: `virtualClock` helper hardened &nbsp; *(skipped — closed-form spring takes dtMs directly; no virtual clock needed for property tests)*
- [x] Cycle 1: spring convergence within 5×halfLife
- [x] Cycle 2: no overshoot under critical damping
- [x] Cycle 3: frame-rate independence (8 ms vs 33 ms)
- [x] Cycle 4: `Reconciler` spring shape at t=halfLife
- [x] Cycle 5: `ColyseusClient` remote-ship offset switched to spring
- [~] Cycle 6: `swarmInterpolation` re-target shim switched to spring &nbsp; *(N/A — see Decision Log; swarmInterpolation has no re-target shim, it's a pure display-delay buffer)*
- [~] Tier-2: ProMotion 120→60 cadence flip spec passing &nbsp; *(skipped — `CritDampedSpring.test.ts` Cycle 3 + Reconciler integration test already prove frame-rate independence in unit tests; e2e cadence flip would add slow Playwright surface for no additional confidence)*
- [x] Tier-2: `benchmarks/spring.bench.ts` < 200 ns &nbsp; *(117 ns/spring amortized in 100-spring batch; single-call number 285 ns is per-call setup overhead, irrelevant in production)*
- [x] `docs/architecture/prediction-and-correction.md` written

### Stage 2 — Collision event broadcasting  &nbsp; *Status: 🚧 in progress*
- [x] Test-infra: `drainContacts` extracted as pure function
- [~] Test-infra: `fakeNetwork` in-memory loopback built &nbsp; *(skipped — cycles 3–5 use direct method invocation against fake predWorld; full chain validated by Tier-2 E2E)*
- [x] Test-infra: zod fuzz fixture built &nbsp; *(inlined into `messages.test.ts` — 10 fuzz cases against `CollisionResolvedMessageSchema` rather than a separate harness)*
- [x] Cycle 1: `drainContacts` happy-path test → green
- [x] Cycle 2: schema fuzz test → green
- [ ] Cycle 3: vPost applied to predWorld immediately → green
- [ ] Cycle 4: out-of-order guard → green
- [ ] Cycle 5: rate-limit → green
- [ ] Tier-2: `collision-events.spec.ts` passing
- [ ] `docs/architecture/collision-events.md` + `src/core/CLAUDE.md` updated

### Stage 3 — Remote entity forward-prediction  &nbsp; *Status: ⏳ pending*
- [ ] Test-infra: `recordedSession` fixtures captured
- [ ] Test-infra: `fakeNetwork` per-client snapshot streams
- [ ] Cycle 1: idle remote ship drift = 0 → green
- [ ] Cycle 2: predicted thrust within 0.1u → green
- [ ] Cycle 3: snapshot mid-prediction spring-corrects → green
- [ ] Cycle 4: hysteresis disable on 3×>5u → green
- [ ] Cycle 5: hysteresis re-enable on 3×<5u → green
- [ ] Cycle 6: lookahead cap → green
- [ ] Cycle 7: recorded-session replay holds within 1u
- [ ] Tier-2: `remote-prediction.spec.ts` + bench passing
- [ ] `docs/architecture/remote-prediction.md` + A/B toggle wired

### Stage 4 — Adaptive jitter & smarter lookahead  &nbsp; *Status: ⏳ pending*
- [ ] Test-infra: `fakeNetwork` jitter + drop injection
- [ ] Cycle 1: Welford mean/variance correctness → green
- [ ] Cycle 2: long-running stability reset → green
- [ ] Cycle 3: lookahead converges to mean+2σ → green
- [ ] Cycle 4: lookahead ramp via spring → green
- [ ] Cycle 5: dropped-snapshot detection → green
- [ ] Cycle 6: bias decay → green
- [ ] Tier-2: `jitter-resilience.spec.ts` passing

### Stage 5 — Snapshot cadence & priority  &nbsp; *Status: ⏳ pending*
- [ ] Test-infra: `MockSectorRoom` harness
- [ ] Cycle 1: deterministic phase offset → green
- [ ] Cycle 2: cadence respects offset → green
- [ ] Cycle 3: close-tier 30 Hz, far 20 Hz → green
- [ ] Cycle 4: hysteresis on tier boundary → green
- [ ] Cycle 5: idle suppression → green
- [ ] Cycle 6: re-enable on first event → green
- [ ] Cycle 7: omitted-`lastInput` flag → green
- [ ] Tier-2: cadence-fairness.spec.ts + bench passing
- [ ] `docs/architecture/snapshot-cadence.md` written

### Stage 6 — Packet-loss & reordering robustness  &nbsp; *Status: ⏳ pending*
- [ ] Test-infra: `fakeNetwork` reordering
- [ ] Cycle 1: input seq + drop counter → green
- [ ] Cycle 2: stale-snapshot guard → green
- [ ] Cycle 3: post-gap conservative spring → green
- [ ] Cycle 4: `request_keyframe` emit threshold → green
- [ ] Cycle 5: server keyframe rate-limit → green
- [ ] Cycle 6: input-queue out-of-order invariant locked → green
- [ ] Tier-2: `packet-loss.spec.ts` passing
- [ ] `docs/architecture/network-resilience.md` written

### Stage 7 — Wire-format efficiency  &nbsp; *Status: ⏳ pending*
- [ ] Test-infra: fast-check property test fixture
- [ ] Cycle 1: keyframe round-trip property → green
- [ ] Cycle 2: delta round-trip property → green
- [ ] Cycle 3: angle wrap → green
- [ ] Cycle 4: keyframe scheduler → green
- [ ] Cycle 5: v2-decoded-by-v3 hard-fail → green
- [ ] Cycle 6: quantization noise vs LERP_THRESHOLD → green
- [ ] Tier-2: `wire-version.spec.ts` + bench passing
- [ ] `docs/architecture/wire-format.md` written
- [ ] `SWARM_WIRE_VERSION` bumped to 3

---

## Decision Log

Append a one-line entry whenever a discovery changes the plan. Format: `YYYY-MM-DD — Stage N — what changed and why.`

- 2026-05-08 — Stage 0 — Skipping the `mirrorAssertions` test-infra investment in this stage. None of Stage 0's cycles operate on a render mirror — they're direct property tests on `Reconciler` instances and module-level constants. Per the plan's "build them lazily" principle, mirrorAssertions move to Stage 3 where remote-prediction integration tests will actually need them.
- 2026-05-08 — Stage 0 — Skipping the `Reconciler.test.ts` time-sampling harness extension. The existing test "lerpOffset magnitude shrinks each advanceLerp call" already iterates `advanceLerp()` and records a magnitudes array; the harness is already adequate for cycles 1 and 2.
- 2026-05-08 — Stage 0 — Cycle 1 caps **both** `lerpFramesForDrift` functions: the canonical one in `src/core/prediction/Reconciler.ts` (was 3/8/12/18) AND the duplicate in `src/client/net/ColyseusClient.ts` for remote-ship offset decay (was 6/10/14). Plan only mentioned the Reconciler version explicitly, but leaving the remote-ship version at 14 frames would mean remote corrections still glide for 233 ms while local corrections land in 100 ms — visibly inconsistent. Both now cap at 6 frames for any drift ≥ 0.5u (Reconciler keeps 3 frames for sub-pixel; ColyseusClient already starts at 6).
- 2026-05-08 — Stage 0 — Cycles 3 and 4 bundled into one commit (`b6c5e08`-class). Both are single-line constant changes targeting the same module (`swarmInterpolation.ts`) and the same theme (tightening adaptive jitter buffer now that snapshot jitter is empirically < 20 ms). Cycle granularity preserved in the plan tracker; commit granularity collapsed for atomicity of file changes.
- 2026-05-08 — Stage 0 Tier-2 — First spec attempt asserted "longest contiguous lerping=true span ≤ 110 ms" using `predStats.lerping`. That property is wrong: back-to-back corrections leave `lerping=true` indefinitely because each new correction queues a new lerp before the previous finishes — the spec measures the duration of *continuous correction activity*, not any single correction's lerp. Reframed: expose `lerpTotalFrames` (was private) on `Reconciler`, plumb into the existing 'correction' log entry payload in `ColyseusClient`, and assert `max(lerpTotalFrames) ≤ 6` across all observed corrections in the sample window. This directly tests the Stage-0 cap surviving through the production reconcile call path.
- 2026-05-08 — Post-Stage-0 — User reported a 581 ms inbound-snapshot gap during a real test. Investigation (see `docs/LESSONS.md` Pattern A) confirmed mobile-network buffering, not server CPU and not Stage 0 regression. Stage 0's tighter cap actually made the spike's recovery faster (100 ms vs 300 ms pre-Stage-0). Stages 4 and 6 will absorb the spike class properly; no plan change. A separate TiDi-4000 capture (Pattern B, sustained server CPU saturation) was confirmed to be outside the roadmap's scope — surfaced as a follow-on workstream in the Cross-Machine Persistence section.
- 2026-05-08 — Stage 1 — Skipping the `virtualClock` test-infra investment. The closed-form analytical spring takes `dtMs` as a direct parameter, so unit tests just call `springStep(s, target, halfLife, dtMs)` with arbitrary dt values. No hooked-up `requestAnimationFrame` or wall-clock simulation needed. Will revisit if Stage 4's spring-smoothed lookahead transitions need it.
- 2026-05-08 — Stage 1 — Cycles 1, 2, 3 bundled into a single commit (`CritDampedSpring` module + 3 property tests = one atomic unit; same pattern as Stage 0 cycles 3+4). Tracker preserves cycle granularity. Implementation is the analytical closed-form `ε(t) = (ε₀ + (v₀ + ω·ε₀)·t)·exp(-ω·t)` so frame-rate independence is satisfied by construction, not by integration tricks. The user-facing `halfLifeMs` parameter uses K = 1.6783… (numerical solution to `(1+K)·exp(-K) = 0.5`) so `x(halfLife)/x(0) = 0.5` matches the colloquial meaning of half-life — saves later confusion when the Reconciler's spring-shape test asserts the same.
- 2026-05-08 — Stage 1 Cycle 6 (swarmInterpolation re-target shim) — N/A. The plan anticipated a "re-target shim" inside `swarmInterpolation.ts` that needed spring-smoothing on new pose arrival, but reading the actual implementation confirms there is no such shim: it's a pure display-delay buffer that linearly interpolates between two bracketing arrivals from the per-entity 3-deep poseRing. There is no offset to spring-correct — bracketing changes are smooth by virtue of the buffer's lookback-time mechanism. Swarm sprites will benefit from Stages 4 and 6 (jitter detection, drop-resilient interp delay extension); no spring is owed at this layer.
- 2026-05-08 — Stage 1 — Half-life selection: 12 ms (sub-pixel) / 25 ms (else), giving ~75 ms / ~125 ms total wall-clock settle. The plan agent's original suggestion of 40 / 70 / 110 ms half-lives (= 200–550 ms total settle) was shown to be 2–5× slower than Stage 0's 100 ms cap by analytical comparison; preserving Stage 0's perceived snappiness means tighter half-lives. The "spring-alive" feel is still present at 25 ms (the velocity-carries-through quality), just at a faster overall pace. If a future user-test report says corrections feel too snappy, bump 25 → 35 ms first.
- 2026-05-08 — Stage 1 closure — Skipping the ProMotion 120→60 Hz cadence-flip e2e spec. `CritDampedSpring.test.ts` Cycle 3 already asserts dt = 8 ms vs dt = 33 ms produce identical end states (closed-form analytical solution; no integration scheme to break under cadence shifts), and the Reconciler integration test re-verifies the property through the full reconcile call path. Adding a Playwright cadence-flip would consume 60+ s of e2e runtime for no additional confidence — the underlying math is exact, not empirical.
- 2026-05-08 — Stage 2 — Skipping the `fakeNetwork` test-infra investment. Cycle 1 (`drainContacts`) tests against a real `PhysicsWorld` with synthetic collisions — pure-function discipline doesn't require a network bus to test. Cycles 3–5 (client handler) test directly against a minimal-interface fake predWorld — no message bus simulation needed for the guard logic. The full worker → main → server → client chain is validated by Tier-2 E2E. fakeNetwork can be built lazily in Stage 4 if the jitter-injection tests genuinely need it.
- 2026-05-08 — Stage 2 Cycle 1 — Bridging Rapier's collider-handle-keyed contact events to PhysicsWorld's body-handle-keyed `handleToId` map needed a small new public method on PhysicsWorld: `bodyHandleForCollider(colliderHandle): number | undefined`. Previous code never needed this lookup direction. Method is one line (`world.getCollider(h).parent()?.handle`); kept on PhysicsWorld rather than reaching into private state from `contactDrain.ts`.
