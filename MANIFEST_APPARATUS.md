# MANIFEST_APPARATUS.md — EQX Peri Environment & Boundary Map

*Living document. Authoritative for the Architect's Master Directive refactor engagement. Update whenever the testing apparatus or zone boundaries change.*

---

## 1. Testing Stack & Exact CLI Commands

| Layer | Runner | Config | Command |
|---|---|---|---|
| Typecheck | `tsc -b` | `tsconfig.{core,server,client}.json` | `pnpm typecheck` |
| Lint / boundary | eslint + `eslint-plugin-import` | `eslint.config.js` | `pnpm lint` |
| Unit | Vitest 2.1.8 (node + jsdom) | `vitest.config.ts` | `pnpm test` (`vitest run`) |
| Integration | Vitest, single-thread, sqlite stub | `vitest.integration.config.ts` | `pnpm test:integration` |
| E2E | Playwright 1.49 (chromium) | `playwright.config.ts` | `pnpm e2e` |
| Bench | Vitest bench | `vitest.config.ts` | `pnpm bench` |
| Mutation | Stryker (vitest runner) | `stryker.config.mjs` | `pnpm mutation` |
| Coverage | v8 (added Phase 1) | `vitest.config.ts` | `pnpm coverage` (`vitest run --coverage --exclude "**/*.integration.test.ts"`) |
| Server boot smoke | tsx | — | `timeout 8 pnpm dev:server` (exit 143 = OK) |

Inner loop: `pnpm typecheck && pnpm lint && pnpm test` (+ 8 s boot smoke for server-touching changes). Outer loop: targeted E2E (`--project=chromium <spec> --reporter=line`). Full green bar: `typecheck && lint && test && e2e && bench`.

Test topology: ~75–84 colocated unit specs; 14 integration specs in `tests/integration/sectorRoom/` (real-WebSocket harness, `harness.ts`); 48 E2E specs in `tests/e2e/`; 4 benches in `benchmarks/`. `fast-check@4.8.0` and `@testing-library/react` are present. **`@colyseus/testing` is present but documented-broken in this repo** (tinypool/structuredClone crash — see `tests/integration/sectorRoom/harness.ts` header + `docs/LESSONS.md` 2026-05-13). Do not use it; the sanctioned SectorRoom lock is the bespoke real-WebSocket harness.

Coverage scope note: `pnpm coverage` instruments the **unit suite only**. The `tests/e2e/**` and `tests/integration/**` trees are excluded by `vitest.config.ts`; the `coverage` script *additionally* appends `--exclude "**/*.integration.test.ts"` so real-`worker_threads` integration tests that happen to live under `src/` (e.g. `src/server/db/dbWorker.integration.test.ts`) do not run under v8 instrumentation — under instrumentation their worker-boot hook exceeds the 10 s `hookTimeout` and aborts coverage finalization. Those tests are **not** removed from the canonical green bar: `pnpm test` still runs them and they pass (verified: `dbWorker.integration.test.ts` 3/3 in 302 ms without coverage). v8 line % therefore reflects unit-test reach. For files whose behavioural lock is integration/E2E (SectorRoom, ColyseusClient, PixiRenderer, App, GalaxyOverviewScreen), unit % is expected low/zero and is *not* the meaningful Phase-2 gate — the named integration/E2E harness + golden trace is. The recorded number is still a real floor Phase 2 must not regress.

---

## 2. Dependency / Boundary Map (decoupled zones — must remain decoupled)

- **`src/core/`** — pure simulation. Allowed runtime: `@dimforge/rapier2d-compat`, `eventemitter3`, `zod`, TS stdlib. No DOM / Node / client / server.
- **`src/server/`** — authority. Allowed: `colyseus`, `@colyseus/schema`, `@colyseus/ws-transport`, `express`, `zod`, `pino` (+ `pino-pretty`), `node:sqlite`, `bcryptjs`, `jose`, `dotenv`. No client lib, no `colyseus.js`.
- **`src/client/`** — UI / render / prediction. Allowed: `colyseus.js`, `react`, `react-dom`, `@mui/*`, `@emotion/*`, `pixi.js` v8, `pixi-viewport`, `pixi-filters`, `howler`, `zustand`, `nipplejs`. No server / Node lib, no `colyseus`.
- **`src/client/render/worker/`** — extra sub-zone: also no React / MUI / Zustand; `protocol.ts` is the only sanctioned channel.
- **`src/shared-types/`** — pure TS + zod only.

Enforcement: ESLint `no-restricted-imports` (string / glob patterns) in `eslint.config.js`; Zustand-purity `no-restricted-syntax` on `store.ts`; canary `src/core/__fixtures__/leak.ts.disabled`. **Known gap:** enforcement is string-pattern, not a true module graph — it can miss transitive / aliased leaks and the canary covers one path. Closed by `dependency-cruiser` (installed Phase 1; DAG ruleset authored Phase 2).

DI seams (core declares the abstraction, zones inject the concretion): `IRenderer`, `IAudio`, `INetworkSink`, `IPersistenceSink`, `IAiBehaviour` in `src/core/contracts/`. Dependency direction flows *into* core only. CI gate order: install → typecheck → lint → test → build → e2e (all-or-nothing, `CI=true`).

---

## 3. Tooling Recommendations

### Tier A — Dev-only, installed in Phase 1 (zero runtime / boundary impact)

1. **`@vitest/coverage-v8`** — objective coverage baseline; makes the directive's "coverage ≥ baseline" gate falsifiable. Pinned to match `vitest@2.1.8`.
2. **`dependency-cruiser`** — asserts the *actual* zone module-graph DAG, closing the string-pattern gap. High value because the refactor relocates modules between files. Ruleset authored in Phase 2.
3. **`knip`** — dead-code / unused-export detection; mechanically shrinks the giant files with near-zero behaviour risk (preferred over `ts-prune` — maintained superset).
4. *(Leverage existing)* **Stryker** `pnpm mutation` — mutation score validates that locks actually constrain behaviour. Coverage ≥ baseline is necessary, not sufficient.

### Tier B — Runtime replacements (USER-APPROVED to pursue)

Each amends the Technology Stack Matrix / Invariant #1 for its zone and requires a CLAUDE.md update in the same PR (Invariant #7). Net-state-sync-adjacent swaps are Phase-3-escalation territory. Sequenced in the Phase-2 re-plan, **not** Phase 1.

5. **`simple-statistics`** (or `@stdlib/stats-incr-*`) → replace `src/core/math/Welford.ts`. Zone: **core** (amends core matrix). Consumers: `Reconciler`, `ColyseusClient` RTT — **network-feel hot path**; treat as Phase-3 escalation with a feel-baseline gate.
6. **`robot`** (~1 KB FSM) or **`xstate`** → replace `src/core/transit/TransitStateMachine.ts`. Zone: **core**. **State-sync-sensitive** (re-arm join readiness) — Phase-3 escalation, contract-preserving only.
7. **`gl-matrix`** / a vec2 lib → consolidate scattered lerp / clamp / vec2 math. Zone: **core / client**. *Architect note:* for 2D game math an internal `src/core/math` consolidation is lower-risk than a dependency; recommended as the fallback if the library's footprint or float precision differs from the hand-rolled code.

### Explicitly kept custom, not replaced

Deliberate, zone-locked, tested — rationale recorded here so the question does not reopen per-file:

- `SnapshotRing` — zero-allocation lag-comp ring; no general-purpose lib preserves the pre-allocation guarantee.
- tick-gated `inputQueue` — load-bearing lockstep discipline; no library standardises it.
- object pools (`GhostProjectile`, `DamageNumbers`, `HealthBars`) — Pixi-specific presentation pooling.
- `CritDampedSpring` — frame-rate-independent feel; game-specific closed form.
- `Bus` — already a thin typed wrapper over the sanctioned `eventemitter3`.
- all network validation — already `zod` at every inbound boundary.
