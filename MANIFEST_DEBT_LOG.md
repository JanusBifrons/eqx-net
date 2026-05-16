# MANIFEST_DEBT_LOG.md — Top-10 Technical Debt & Action Plan

*Living document. Updated after each file in Phase 2 with what changed, why, and assumptions.*

---

## Execution order (risk-ascending)

Safe / dev-only → confidence-builders → state-sync-sensitive → network-feel hot path → 3400+ LOC giants. **No giant is gated on a unit test** (Invariant #13: test where the bug lives). `@colyseus/testing` is forbidden. Phase-2 gate per file = **all tests pass AND coverage ≥ recorded baseline AND Stryker mutation ≥ stated floor AND perf / feel baseline not regressed** (8 s boot smoke + `pnpm bench` + the relevant diagnostics spec).

| # | File | LOC* | Zone | Test lock (existing harness) | Baseline cov† |
|---|---|---|---|---|---|
| 1 | `src/server/routes/diagRouter.ts` | 525 | server | `diagRouter.test.ts` + `diagRouter.playerShips.test.ts` (route-level) | 59.9% |
| 2 | `src/client/render/HaloRadar.ts` | 625 | client | E2E radar spec; **add dedicated unit test in Step 1** | 34.2% |
| 3 | `src/client/components/GalaxyOverviewScreen.tsx` | 533 | client | `@testing-library/react` component + galaxy E2E | 0.0% ‡ |
| 4 | `src/client/state/store.ts` | 585 | client | slice unit tests + `tsc` / lint consumer-fanout | 79.9% |
| 5 | `src/client/App.tsx` | 1167 | client | `App.*` test + E2E phase specs | 0.0% ‡ |
| 6 | `src/server/transit/TransitOrchestrator.ts` | 343 | server | `TransitOrchestrator.test.ts` + integration `joinBroadcastGrace` | 98.3% |
| 7 | `src/core/prediction/Reconciler.ts` | 291 | core | `Reconciler.test.ts` + `fast-check` + E2E `feel-test-lockstep` | 93.1% |
| 8 | `src/client/render/PixiRenderer.ts` | 2189 | client | E2E `renderer-worker-probe` / `wreck-render-probe`; pure `spriteUpdateDecisions.ts` | 4.4% ‡ |
| 9 | `src/client/net/ColyseusClient.ts` | 3424 | client | E2E `feel-test-lockstep` / `prediction-diagnostics`; ~8 unit specs = insurance | 30.8% ‡ |
| 10 | `src/server/rooms/SectorRoom.ts` | 3873 | server | `tests/integration/sectorRoom/*` real-WS harness + `sector-alpha` E2E | 0.0% ‡ |

\* LOC approximate (counting method varies ±10 %); exact `cloc` recorded per file at Phase-2 time.
† Unit-suite v8 line % captured during Phase-1 execution (`pnpm coverage`) and written into the table below before the Phase-1 commit. For integration/E2E-locked files (8, 9, 10) unit % is expectedly low — the meaningful lock is the named harness, not this number; the number is still a floor Phase 2 must not regress.

### Baseline coverage (v8, captured Phase-1 execution)

<!-- BASELINE-COVERAGE-START -->
Captured via `pnpm coverage` (vitest 2.1.9 + `@vitest/coverage-v8`, unit suite). The `coverage` script appends `--exclude "**/*.integration.test.ts"` so real-`worker_threads` integration tests (e.g. `dbWorker.integration.test.ts`) don't run under v8 instrumentation — under instrumentation their worker-boot hook tips past the 10 s `hookTimeout` (collection ballooned to ~257 s). Those tests still run and pass under the canonical `pnpm test` (verified: `dbWorker.integration.test.ts` 3/3 green in 302 ms without coverage). This keeps the dev-only baseline stable and matches the documented coverage scope (unit reach; integration/E2E excluded).

| # | File | Lines % | Funcs % | Branch % |
|---|---|---|---|---|
| 1 | `diagRouter.ts` | 59.87 | 66.66 | 83.33 |
| 2 | `HaloRadar.ts` | 34.23 | 41.66 | 95.45 |
| 3 | `GalaxyOverviewScreen.tsx` ‡ | 0.00 | 0.00 | 0.00 |
| 4 | `store.ts` | 79.87 | 28.26 | 100.00 |
| 5 | `App.tsx` ‡ | 0.00 | 0.00 | 0.00 |
| 6 | `TransitOrchestrator.ts` | 98.31 | 100.00 | 85.71 |
| 7 | `Reconciler.ts` | 93.12 | 100.00 | 74.19 |
| 8 | `PixiRenderer.ts` ‡ | 4.43 | 6.97 | 100.00 |
| 9 | `ColyseusClient.ts` ‡ | 30.76 | 40.00 | 40.81 |
| 10 | `SectorRoom.ts` ‡ | 0.00 | 0.00 | 0.00 |
| — | **Repo total (unit suite)** | **34.49** | **58.85** | **78.57** |

‡ = integration/E2E-locked file. Low/zero unit % is **expected and correct** — the meaningful Phase-2 gate for these is the named integration/E2E harness + a golden trace, not this number. The number is recorded only as a floor Phase 2 must not *decrease* (a refactor that deletes unit reach without replacing the harness lock fails the gate). `GalaxyOverviewScreen.tsx`, `App.tsx`, `SectorRoom.ts` at 0.0 % empirically confirm the manifest's "test where the bug lives" stance: their behaviour is exercised only at the E2E/integration layer.
<!-- BASELINE-COVERAGE-END -->

**Qualitative coverage baseline (pre-v8, from test-file presence, for reference):** core ~76 % modules tested, server ~54 %, client ~71 %, shared-types ~25 %. Notably thin / untested large modules: `physics/worker.ts`, `net/snapshotScheduler.ts`, `auth/AuthService.ts`, `shipKinds.ts`. `SectorRoom.ts` has only `SectorRoom.shipKey.test.ts` at unit level — its real lock is the integration harness.

---

## Per-file action plan (specific intent, not "refactor")

**1. `diagRouter.ts`** — Extract a `DIAG_QUERIES` registry (`{ name, handler(gameServer) }`); router becomes a thin auth + loop. Extract `SnapshotSerializer` / `TiDiStatsFormatter` for the complex serialization endpoints. Dev-only, out of the game loop — proves the verification sandwich.

**2. `HaloRadar.ts`** — Extract `HaloRadarEntityLayer` (entity sprite-sync loops) and `HaloRadarCamera` (zoom / pan transform); radar dispatches to both. Add the missing dedicated unit test in Step 1 (lock before extract).

**3. `GalaxyOverviewScreen.tsx`** — Extract React-independent `GalaxyGridInteractionManager` (click-to-select, sector-boundary visibility); screen dispatches and re-renders on returned selection state. Makes grid logic testable without a React mount.

**4. `store.ts`** — Group 40+ flat fields into nested namespaces (`hud` / `connection` / `phase` / `ui` / `dev`). Low per-line risk, **high consumer fan-out** — sequenced after the loop is proven, not as warm-up. Zustand-purity lint is the guardrail; `tsc` + lint catch every consumer.

**5. `App.tsx`** — Extract `useGameSurfaceLifecycle` hook (the 7 useEffects), `OverlayStack` (5 overlays, z-ordered), `PhaseRouter` (phase → screen). Public component API unchanged.

**6. `TransitOrchestrator.ts`** — Extract `TransitValidator` (ownership / destination / Limbo-roster checks → `{ valid | reason }`). **State-sync-sensitive** (re-arm join readiness is historically fragile) — contract-preserving only; route any FSM-semantics change through Phase-3 escalation.

**7. `Reconciler.ts`** — Phase the 100-LOC `reconcile()` into `replayInputWindow()` → `computeDrifts()` → `applySprings()`. **Network-feel hot path** — `fast-check` invariants + E2E feel baseline; perf / feel regression fails the gate even if unit tests are green.

**8. `PixiRenderer.ts` (giant)** — Extract `PixiSceneGraphBuilder`, route sprite decisions through the existing pure `spriteUpdateDecisions.ts`, `WarpEffectStateMachine`, per-pool managers (`DamageNumberPool` etc.). Lock at E2E (crosses the worker / structured-clone seam — the 2026-05-14 incident layer); unit tests are fast insurance only.

**9. `ColyseusClient.ts` (giant)** — Extract `SnapshotMirrorSynchronizer`, `ReconciliationParams` builder, `RenderMirrorUpdater`, `ClientInputManager`, `ClientGameRuleEngine`. Lock at E2E feel / prediction-diagnostics (numeric golden); ~8 unit specs = insurance per the "write BOTH" rule.

**10. `SectorRoom.ts` (giant)** — Extract `WeaponMountService` (respecting Invariant #12 single-ownership), `CombatResolver`, `SnapshotBroadcaster`, `PlayerJoinManager`, `initializeSwarmSpawner`. Lock at the **integration real-WebSocket harness** with a golden snapshot / broadcast trace; `@colyseus/testing` forbidden. Snapshot / backpressure or re-arm-FSM changes → Phase-3 escalation, never the autonomous loop.

---

## Phase 2 / 3 governing rules (recorded for the re-plan)

- "Isolated session per file" ≠ "unit-isolated test." Each file's lock is the layer where its bugs live (table above).
- Coverage gate is necessary-not-sufficient → AND mutation score AND perf / feel baseline.
- Halt + escalate (directive Phase 3): regression unresolved in 2 iterations; touching auth / encryption / critical net state-sync (SectorRoom snapshot path, re-arm FSM, Reconciler drift); or a hallucinated / forbidden API (e.g. `@colyseus/testing`).
- Public interfaces / API contracts / Colyseus `@colyseus/schema` definitions: unchanged without explicit per-change approval.

---

## Phase 2 change log (appended per file as completed)

_Empty — Phase 2 not yet started. Each completed file appends: what changed, why, assumptions, baseline vs. post coverage + mutation deltas._
