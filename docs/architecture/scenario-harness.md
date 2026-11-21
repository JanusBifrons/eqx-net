# Scenario Harness — Network-Feel Regression Tests

Stage 4.5 of the network-feel roadmap. The harness simulates the client's input-clock state machine through synthetic timelines, asserting system-level properties that pure-function unit tests can't catch.

## Why this exists

Stages 0–4 of the network-feel roadmap shipped multiple emergent-over-time bugs (`docs/LESSONS.md` Pattern A, the Welford-σ explosion, the inputTick-starvation race) that the test suite never caught. Every Stage 0–4 unit test verified an *atomic operation* in isolation — `welfordPush` is correct, `computeDesiredLead` is correct, the spring math is correct. None of those tests could exercise emergent properties like *"the system stays sane when a 552 ms gap interacts with held-ack-advance on a 10 Hz rafTick device"*.

The 2026-05-08 user-driven test-discipline pivot: every regression we fix gets a permanent fixture in this harness. If the fix is reverted (or a future change re-introduces the same class of bug), the harness fails on CI before the regression reaches production.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ tests/scenarios/                                          │
│                                                           │
│ types.ts      — Event, Observation, SimulatedClientState  │
│ runner.ts     — runScenario(events, opts) → Observation[] │
│ scenarios.ts  — Scenario → Event[] builder                │
│ assertions.ts — ticksAheadNeverBelow, σBoundedBy, …       │
│ regressions.test.ts — one test per user-reported issue    │
└────────────────────┬──────────────────────────────────────┘
                     │ uses
                     ▼
┌──────────────────────────────────────────────────────────┐
│ Production pure modules (the real production code,       │
│ not test doubles):                                        │
│                                                           │
│  src/core/math/Welford.ts                                 │
│  src/client/net/lookaheadController.ts                    │
│  src/client/net/snapshotDropDetector.ts                   │
│  src/client/net/inputTickRecovery.ts                      │
│  src/client/net/clockAnchor.ts                            │
└──────────────────────────────────────────────────────────┘
```

The harness's `runScenario` mirrors `ColyseusClient.handleSnapshot` and `ColyseusClient.tickPhysics`'s control flow, minus physics + DOM + Colyseus surface. It uses the **real** production modules, not stubs — so it tests the actual code-paths that ship to users.

## Network model: gaps, bursts and frame stalls

`runner.ts` also models the transport as it really behaves: both streams (JSON snapshots every third tick, drone packets every tick) are reliable and ordered. Pure and seeded; no timers.

- `GapSpec` (`types.ts`) extends the `{ atMs, durationMs }` gap shape with an optional `streams: 'json' | 'swarm' | 'both'` (default both). Everything sent during the stall arrives together, in send order, at `atMs + durationMs + baseDelayMs`. `Scenario.gapsMs` in `scenarios.ts` is unchanged.
- `FrameStallSpec` stalls the client frames: no frame fires inside it, the next fires at its end.
- `buildDeliveries(profile, durationMs)` returns every packet with its arrival time; `buildFrameTimes` returns the frame times; `buildNetworkEvents` turns a profile into `runScenario` events.
- Named profiles live in `gapProfiles.ts`: `lan-clean`, `gap-200`, `gap-400`, `gap-600`, `burst-600-both-streams`, `gap-json-only`, `gap-swarm-only`, `frame-stall-250`, `jitter-4g` (JSON gaps p50 52, p95 91, p99 170 ms from the 4G capture; both streams share the link lag). Same seed, same delivery list.
- Self-tests: `gapProfiles.test.ts`.
- `countMotionArtefacts(frames, opts)` (`assertions.ts`) scores one drawn track against its true track, one `{ atMs, drawnX, drawnY, trueX, trueY }` per frame in simulated ms: snaps (largest, total), freeze frames, backward steps, mean and max lateness; `ignoreFirstMs` skips warm-up. Self-tests: `assertions.motion.test.ts`.
- `gapSmoothing.drones.test.ts` drives the real drone path (`decodeSwarmPacket` with tick stamping, the lateness-based display-delay target, `interpolateSwarmPose`) through every profile with a straight and a turning drone, and records today's motion counts and swarm counters per profile; `runDroneFixture(profile, { timeScale })` takes the sector game speed.
- Capture fixture `capture-2026-11-21` (`fixtures/capture-2026-11-21.json`): the server tick and arrival time of every JSON snapshot logged in the 2026-11-21 4G Android Chrome playtest (~150 s, one segment per join; numbers only), loaded by `loadCaptureFixture` + `captureToDeliveries` in `ondeviceReplay.ts` as one `Delivery` list per join. Self-test: `captureFixture.test.ts`.

## What the harness does *not* simulate

- **Physics** — the harness focuses on the input-clock and prediction-window state. Reconciler replay, predWorld integration, collision events are out of scope. Those are tested at the unit level (`Reconciler.test.ts`, `contactDrain.test.ts`, etc.) and at the E2E level (`tests/e2e/feel-tuning.spec.ts`, `tests/e2e/collision-events.spec.ts`).
- **Colyseus / WebSocket** — the harness is pure. It doesn't spawn a server or open a socket.
- **DOM / Pixi rendering** — out of scope.

## Adding a new fixture

When you find a real-world regression in a user diagnostic:

1. **Capture the diagnostic** — make sure it's preserved under `diag/captures/` so future-you can refer back.
2. **Identify the conditions** that trigger the bug. Look for: rafTick rate, RTT mean, jitter, snapshot gaps, sustained input pattern.
3. **Build a `Scenario`** in `regressions.test.ts` reproducing those conditions:
   ```ts
   const events = buildScenarioEvents({
     name: 'descriptive-name',
     rafTickHz: 10,
     rttMs: 50,
     gapsMs: [{ atMs: 5000, durationMs: 552 }],
     durationMs: 12_000,
   });
   ```
4. **Identify the property** the production code violates. E.g., "ticksAhead never goes below 0", "Welford σ stays under 100 ms", "no correction > 50 u".
5. **Write the assertion** with helpers from `./assertions.ts` (or add a new helper if the property isn't covered).
6. **Verify TDD discipline** with a paired demonstration test using the runner's bypass flags:
   ```ts
   it('TDD demonstration: WITHOUT hotfix, the regression reproduces', () => {
     const observations = runScenario(events, { starvationRecoveryEnabled: false });
     expect(ticksAheadNeverBelow(observations, 0).passed).toBe(false);
   });
   ```
   This pair (the regression test passing under production behaviour, the demonstration test failing under bypassed behaviour) proves the fix is load-bearing and the harness exercises it.
7. **Document the diagnostic timestamp + commit hash** in the test description so future investigations have a thread to pull on.

## What's currently covered

The initial fixture set covers the two 2026-05-08 user-reported regressions:

- **Hotfix #1 — RTT clamp / Welford σ bound under outliers.** A Pattern A 572 ms snapshot gap on a healthy-RTT desktop session injects a 572-ms outlier into Welford. Without the clamp, σ explodes; with the clamp, σ stays bounded. (`docs/LESSONS.md` "RTT is *not* a clean RTT signal".)
- **Hotfix #2 — inputTick starvation under slow rafTick + held-ack-advance.** On a 10 Hz rafTick device, the held-ack-advance contract makes `ackedTick` outpace `inputTick` regardless of network conditions. Without the recovery, `ticksAhead` goes negative. (`docs/LESSONS.md` "inputTick starvation".)

Plus a steady-state baseline (60 Hz rafTick + healthy network → no recoveries fire) and the matching TDD demonstrations for both hotfixes.

## Roadmap for additional coverage

Future user diagnostics will reveal more emergent bugs. Each gets a fixture here:

- (Reserved) Stage 6 — packet-loss bursts: assert no perceptible jitter under 10 % loss.
- (Reserved) Stage 7 — wire-version interactions: assert decoder hard-fail on protocol skew.
- (Reserved) Mobile tab-pause / browser-throttle scenarios.

The fixture set is append-only; never delete a regression test, even after the underlying bug class has been refactored away. The cost of keeping an old test is near-zero; the cost of a silent regression is large.
