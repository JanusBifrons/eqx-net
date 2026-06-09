# EQX Peri — Codebase Health, Security & Robustness Remediation Plan

## Context

A full macro review of EQX Peri (architecture/SOLID, security, testing/robustness, CI enforcement) was performed on 2026-06-09 at commit `b272bc6`. The goal: improve project health, close security holes, and make the system more robust — producing this plan for a future agent to execute.

**What the review found is healthy (do NOT touch / re-litigate):**
- Zone boundaries (core/server/client/shared-types) are clean and ESLint-enforced; the canary fixture `src/core/__fixtures__/leak.ts.disabled` exists and works.
- All 12 Colyseus `onMessage` handlers are zod `.strict()`-validated; all SQL is parameterized via `.prepare()`; input rate-limit 3/tick, fire cooldowns, and 50KB/250KB backpressure all in place.
- Event bus is a single discriminated union; Zustand purity holds (lint-enforced); fixed timestep holds; DI contracts in `src/core/contracts/` are real and injected at bootstrap; `strict: true` + `noUncheckedIndexedAccess`, zero `as any` in src/.
- Graceful SIGTERM/SIGINT drain exists in `src/server/index.ts`.

**What this plan deliberately does NOT cover:** god-class decomposition of the top-10 oversized files (`SectorRoom.ts` ~3.9k LOC, `ColyseusClient.ts` ~4.9k LOC, `PixiRenderer.ts`, `App.tsx`, `store.ts`, …). That is owned by the existing engagement in `MANIFEST_APPARATUS.md` + `MANIFEST_DEBT_LOG.md` (Phase 2, per-file, coverage/mutation/perf-gated, not yet started). This plan is the complement: the HTTP/bootstrap/process/auth layer the netcode-focused apparatus never covered. Structural edits to those 10 files are forbidden here; only the surgical touches named per step.

**Conventions every step obeys (root `CLAUDE.md`):**
- Inner loop: `pnpm typecheck && pnpm lint && pnpm test`; server-touching steps also `timeout 8 pnpm dev:server` (exit 143 = OK).
- Invariants #9/#13: every behavioural change ships with a test in the layer where the bug lives; locks come BEFORE fixes.
- Invariants #7/#10: new env vars / thresholds / contracts update CLAUDE.md + docs in the same PR.
- Commit per green step: `fix(security): CORS origin allowlist (A1, plan: squishy-canyon)`.
- `pnpm e2e:netgate` ONLY where flagged (live-loop). Only **A5** and **B4** need it.

---

## Verified findings (all confirmed by direct file reads/grep, not just sub-agent reports)

### Security
| ID | Finding | Evidence | Severity |
|---|---|---|---|
| S9 | JWT secret falls back to hardcoded `'dev-secret-change-in-production'` — production boot without `JWT_SECRET` mints forgeable sessions | `src/server/auth/jwt.ts:3-5` | **Critical** |
| S1 | CORS `Access-Control-Allow-Origin: *` on all routes | `src/server/index.ts:34` | Critical |
| S2 | No rate limiting on `/auth/register`, `/auth/login`, `/auth/google/callback` (bcrypt per request = CPU brute-force surface); no helmet/express-rate-limit anywhere | `src/server/routes/authRouter.ts` | Critical |
| S3 | OAuth callback puts JWT in URL: `res.redirect(\`/?token=${...}\`)` → browser history / logs / referrers | `src/server/routes/authRouter.ts:150` | Critical |
| S6 | All test/engineering rooms (`test-sector`, `test-sector-fast`, `auto-fire-test`, `galaxy-test`, `swarm-tidi-burn`, `structure-scenario-test`, …) defined **unconditionally** — production clients can join them and use test overrides (`initialHull`, `testTimeScale:10`, `dronePoses`); `swarm-tidi-burn` (`tickBurnMs`) is a free CPU-burn DoS. `EQX_ALLOW_DEV_OVERRIDES` (`SectorRoom.ts:163`) additionally bypasses testMode gating and is undocumented | `src/server/index.ts:214-656` | High |
| S4 | OAuth CSRF state is an in-memory `Map` — races, lost on restart, broken multi-instance | `src/server/routes/authRouter.ts:~100` | High |
| S5 | Unbounded zod fields: `clientShotId` (`src/shared-types/messages/clientMessages.ts:33`, `combatMessages.ts:154`), `targetSectorKey` (`clientMessages.ts:73`); unbounded arrays in `JoinOptionsSchema` (`dronePoses`, `scenarioDrones`, `prebuiltStructures`, …) — payload DoS | shared-types + `SectorRoom.ts:~165-245` | High |
| S7 | No security headers (nosniff, X-Frame-Options, Referrer-Policy, HSTS) | `src/server/index.ts` | Medium |
| S8 | `LimboStore` has no entry cap (adversarial disconnect bursts); `DB_PATH` defaults to cwd `./eqx.db` | `src/server/limbo/LimboStore.ts` | Medium |

### Robustness
| ID | Finding | Evidence |
|---|---|---|
| R1 | No `process.on('uncaughtException')` / `('unhandledRejection')` — verified zero grep hits in src/server | `src/server/index.ts` |
| R2 | No React ErrorBoundary anywhere in src/client | `App.tsx` unwrapped |
| R3 | OffscreenCanvas render-worker crash unobservable; no fallback to main-thread `PixiRenderer` | `src/client/render/` worker client |
| R4 | Persistence worker: ~5 silent `catch {}` blocks (lines ~128, 137, 203, 258, 290), no `worker.on('error')` on main thread — SQLite failures vanish, queue grows | `src/server/db/PersistenceWorker.ts` |
| R5 | Zero-test subsystems: `src/server/auth/` (3 files incl. AuthService/jwt/GoogleOAuth), `identity/`, `transport/` (partial), `stats/`, `workers/` | — |
| R6 | No deployment story: no Dockerfile, no deploy workflow, no runbook; `.env.example` missing most env vars | — |
| R7 | ~29 `console.*` in src/client (15 in `ColyseusClient.ts`); 2 in `authRouter.ts` — bypass ClientLogger/pino | — |

### CI / enforcement gaps (vs invariant #8 and the Technology Stack Matrix)
- C1: `pnpm bench` not in CI (invariant #8 lists it as a green bar).
- C2: `dependency-cruiser` + `knip` listed in the stack matrix and MANIFEST as installed tooling, but **no config files exist** and neither is in CI — boundary enforcement is string-pattern ESLint only (gap acknowledged in `MANIFEST_APPARATUS.md` §2).
- C3: vitest v8 coverage runs but has no thresholds and no CI gate (Phase-1 baseline: lines 34.49% / funcs 58.85% / branches 78.57%, recorded in `MANIFEST_DEBT_LOG.md`).
- C4: invariant #14 alloc-lint is an acknowledged deferred follow-up — leave it, but track.
- C5: no `pnpm audit` / dependency scanning in CI.

### Test hygiene (violates the repo's own documented anti-patterns)
- T1: **144 `waitForTimeout` calls + 46 `test.setTimeout` bumps** in `tests/e2e/` — root CLAUDE.md "Test-harness philosophy" forbids exactly this. Worst: `sync-health.spec.ts:24`, `interceptor-beam-stays-connected.spec.ts:86`, `input-throttle-drift.spec.ts:98`, `living-world.spec.ts` (180 s).
- A1-arch: worker-renderer vs main-thread `PixiRenderer` fallback have no substitutability/parity test (LSP risk).
- A2-arch: only ~5 piercing integration tests in `tests/integration/sectorRoom/` for the 3.9k-LOC room.

---

## Workstream A — Security hardening (do first)

### A0. Test lock for the auth subsystem BEFORE touching it (M) — prerequisite for A2/A3/A4/A9
- Create `src/server/routes/authRouter.test.ts` following the **`src/server/routes/diagRouter.test.ts` pattern** (mock `../db/Database.js`, mount router on throwaway express app, real HTTP against ephemeral port).
- Create `src/server/auth/AuthService.test.ts` + `src/server/auth/jwt.test.ts` (register/login round-trip with mocked sink, jwt sign/verify/expiry).
- Lock CURRENT behaviour including the `/?token=` redirect shape — A3 then changes that test deliberately (history-readable).
- Verify: inner loop. Netgate: no. Commit: `test(auth): route-level + service locks (A0)`.

### A1. CORS origin allowlist (S1) (S)
- Replace the `*` middleware (`src/server/index.ts:33-40`) with `corsMiddleware(allowedOrigins)` in a new `src/server/net/httpCors.ts` (house style mirrors `src/server/net/Backpressure.ts` — hand-rolled, unit-tested, no new dep). Echo `Origin` when in `ALLOWED_ORIGINS` (comma-separated env); default `http://localhost:5173` when `NODE_ENV !== 'production'`; no header otherwise.
- Explicit non-goal: origin-checking the Colyseus WS upgrade (transport seam — record as deferred in E1's security doc).
- Lock: `httpCors.test.ts` (allowed/disallowed/no-origin/dev-default) + one assertion in `authRouter.test.ts`.
- Verify: inner loop + boot smoke + `pnpm e2e --project=chromium tests/e2e/boot.spec.ts --reporter=line`. Netgate: no. Commit.

### A2. Rate limiting on auth endpoints (S2) (M) — after A0
- New `src/server/net/HttpRateLimit.ts`: hand-rolled fixed-window per client IP (extract and reuse the `clientIp()` x-forwarded-for helper from `authRouter.ts:28-32`). Budgets: login/register 10/min/IP; `/auth/google*` 30/min/IP. Bounded Map + periodic prune. 429 + `Retry-After`.
- (If implementer prefers `express-rate-limit`/`helmet`: allowed, but MUST amend the Technology Stack Matrix + `src/server/CLAUDE.md` allowed-imports in the same PR per invariant #7.)
- Apply per-route in `authRouter.ts` only — not globally (don't throttle `/healthz`, `/diag`).
- Lock: `HttpRateLimit.test.ts` (window roll-over, per-IP isolation, prune) + a 429 route case in `authRouter.test.ts`. Confirm Playwright global-setup (`/auth/dev/test-token`, one request) is unaffected.
- Verify: inner loop + boot smoke. Netgate: no. Commit. Docs: budgets added to `src/server/CLAUDE.md` Thresholds.

### A3. OAuth callback → one-time code exchange (S3) (M) — after A0
- `authRouter.ts:150`: store JWT in a 60 s-TTL single-use map keyed by `randomUUID()`; redirect `/?authCode=<code>`; add `POST /auth/exchange { code } → { token, user }` (delete on read).
- Client half: find the `?token=` pickup in the client boot path and swap to `authCode` → `POST /auth/exchange`. This touches `App.tsx` (MANIFEST file #5) — keep it a surgical URL-param read swap, zero restructuring.
- Lock: route-level — code round-trip, second exchange rejected, TTL expiry (`vi.useFakeTimers`); unit test an extracted client `exchangeAuthCode()` helper.
- Verify: inner loop + boot smoke. Netgate: no. Commit.

### A4. OAuth CSRF state → stateless HMAC (S4) (S) — after A0
- Replace the `oauthStates` Map with signed state: `nonce.timestamp.HMAC(secret, nonce+timestamp)`; verify signature + TTL on callback. Survives restarts/multi-instance. (Trade-off: loses strict single-use — acceptable for a 10-min CSRF nonce; record in security doc, or keep a small TTL-pruned replay set.)
- Lock: valid round-trip / tampered → 400 / expired → 400 in `authRouter.test.ts`.
- Verify: inner loop + boot smoke. Netgate: no. Commit.

### A5. zod payload bounds (S5) (S) — ⚠ touches the fire path → **netgate required**
- `clientMessages.ts:33` `clientShotId` → `.min(1).max(64)`; `combatMessages.ts:154` same; `clientMessages.ts:73` `targetSectorKey` → `.max(64)`.
- `SectorRoom.ts` `JoinOptionsSchema`: `.max(64)` on `dronePoses` / `scenarioDrones` / `scenarioAsteroids` / `prebuiltStructures` / `structurePoses` / `droneKinds` arrays + bounds on nested numbers. Leave `.passthrough()` (room options ride it).
- Lock: extend `src/shared-types/messages.test.ts` (accept-at-max / reject-over-max per field) + a `tests/integration/sectorRoom/` case joining with oversized `dronePoses` and asserting rejection (see D4).
- Verify: inner loop + boot smoke + **`pnpm e2e:netgate`** (~6-8 min — `FireMessageSchema` parsing is on the fire path; do not predict, run it). Commit.

### A6. Gate test/engineering rooms out of production (S6) (M)
- Feasibility verified: all room definitions are top-level `gameServer.define()` calls in `index.ts:214-656`; the integration harness defines its own rooms on its own Server; Playwright's webServer never sets `NODE_ENV=production` — gating by env breaks neither suite.
- Extract every non-galaxy `define` into new `src/server/rooms/registerTestRooms.ts` → `registerEngineeringAndTestRooms(gameServer)`. Call from `index.ts` only when `NODE_ENV !== 'production' || EQX_ENABLE_TEST_ROOMS === '1'` (same gate shape as the `/dev/*` routes at `index.ts:102`). Gate ALL of them, including `swarm-tidi-burn`/`swarm-soak`/`swarm-tidi` (load/burn rooms). Galaxy rooms (`index.ts:207-209`) stay unconditional. Production join of a gated room fails at matchmaking — correct failure mode.
- Also: `logger.warn` at boot when `EQX_ALLOW_DEV_OVERRIDES=1` AND `NODE_ENV==='production'` (don't change its semantics — `e2e:phone:stall` depends on it).
- Lock: `registerTestRooms.test.ts` with a recorder-fake `{ define, filterBy }` asserting the full expected room-name set (doubles as a drift lock). Gate condition covered by dev boot smoke + a manual `NODE_ENV=production` boot check (needs `JWT_SECRET` set once A9 lands).
- Verify: inner loop + dev boot smoke + production-mode boot smoke + **full local `pnpm e2e` smoke run** (every E2E spec depends on these rooms — this step is the likeliest to break the suite via an extraction typo; budget the multi-minute run, background + log file per root CLAUDE.md playbook). Netgate: no (registration-time only). Commit.
- Docs (invariant #7): root CLAUDE.md bespoke-triggers table rows that point at `src/server/index.ts` room definitions → update pointers to the new file.

### A7. Security headers (S7) (S)
- Sibling middleware to A1: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (also mitigates residual S3 referrer leakage), HSTS only when `NODE_ENV === 'production'`. **Skip CSP** — the express server is API/WS-only (no `express.static`); CSP belongs to the client-hosting layer; record in security doc.
- Lock: middleware unit cases + one route assertion. Verify: inner loop + boot smoke. Netgate: no. Commit.

### A8. LimboStore cap + DB path docs (S8) (S)
- `LimboStore.ts`: max-entries cap (~10 000); on overflow evict earliest-expiring entry + sampled `pino.warn`.
- `DB_PATH`: docs-only (E1/E2 runbook sets a volume path in production).
- Lock: extend existing `LimboStore.test.ts` (cap, eviction order, warn). Verify: inner loop + boot smoke. Netgate: no. Commit.

### A9. Fail-closed JWT secret (S9) (S) — after A0
- `src/server/auth/jwt.ts:3-5`: keep dev fallback when `NODE_ENV !== 'production'`; in production, missing OR literal-placeholder `JWT_SECRET` → **throw at boot** (a server minting forgeable sessions must not start).
- Lock: `jwt.test.ts` env-stub cases. Verify: inner loop + dev boot smoke + `NODE_ENV=production` boot check with/without the var. Netgate: no. Commit. `.env.example` marks `JWT_SECRET` production-required.

---

## Workstream B — Operational robustness

### B1. Process-level crash handlers (R1) (S)
- New `src/server/orchestration/processGuards.ts`: `installProcessGuards({ logger, onFatal })` for `uncaughtException` + `unhandledRejection` → `logger.fatal` → route into the EXISTING `shutdown()` drain (`index.ts:~743`) with its 10 s hard deadline → exit non-zero. Inject the process emitter for testability. Do NOT log-and-continue — an authority in unknown state must restart (E2's supervisor handles it).
- Lock: unit test with fake EventEmitter-as-process (registration, fatal log, onFatal once, double-fault → immediate exit). Verify: inner loop + boot smoke. Netgate: no. Commit.

### B2. Persistence-worker observability (R4) (M)
- `PersistenceWorker.ts`: add main-thread `worker.on('error')` + `worker.on('exit')` (non-zero) → `pino.error` + failure counter; replace the five silent `catch {}` blocks with sampled `pino.warn` (1% for high-frequency per the Pino policy) + counters. Expose `persistence: { failures, queueDepth }` on `/healthz` (cheap integer reads). Error-level alarm when the CRITICAL write-ahead buffer repeatedly exceeds its documented 10 000-op cap.
- Do NOT change lane semantics, batching windows, or drain protocol (load-bearing, threshold-documented in `src/server/CLAUDE.md` Phase 7).
- Lock (invariant #13 — bug lives at the `worker_threads` boundary): extend `src/server/db/dbWorker.integration.test.ts` (already real-worker, runs under `pnpm test`): kill/poison the worker, assert error surfaced + counter incremented. Unit tests for catch-path logging as insurance.
- Verify: inner loop + boot smoke. Netgate: no. Commit.

### B3. React ErrorBoundary (R2) (S)
- New `src/client/components/AppErrorBoundary.tsx` (class component, `componentDidCatch` → ClientLogger + minimal "something broke — reload" fallback UI). Wrap the App root at the mount point (**outside `App.tsx`** so MANIFEST file #5 isn't restructured).
- Lock: `@testing-library/react` test (throwing child → fallback rendered, logger called). Verify: inner loop. Netgate: no. Commit.

### B4. Render-worker crash observability + fallback (R3) (L) — ⚠ render loop → **netgate required**; D3 parity test is a strict prerequisite
- `WorkerRendererClient`: `worker.onerror`/`onmessageerror` → ClientLogger + bus event; on worker death, fall back to main-thread `PixiRenderer` (the IRenderer LSP substitution — D3 proves drop-in first). If fallback proves hairy: ship observability + error overlay first (S), fallback as follow-up commit.
- Lock (invariant #13 — worker boundary): Playwright probe-page pattern (canonical: `src/client/__offscreen-spike__/damage-number-probe-main.ts` + `tests/e2e/damage-number-lifetime.spec.ts`): inject a thrown error inside the render worker, assert (a) error observable, (b) fallback takes over (screenshot non-black — the worker path screenshots black, main-thread doesn't, which makes the assertion easy via `galaxy-test` + `?worker=` machinery).
- Verify: inner loop + targeted E2E + **netgate** (invariant #8 names the client render loop). Two commits: observability, then fallback+parity. Docs: renderer fallback ladder note under `docs/architecture/` (invariant #10).

### B5. console.* → logger sweep + lint lock (R7) (M)
- `authRouter.ts:122,153` → pino child logger (rides any A-step touching the file). Client: migrate ~29 `console.*` (15 in `ColyseusClient.ts`) to ClientLogger — **mechanical call-site swaps only** (MANIFEST file #9; zero restructuring; coordinate via its change log if Phase 2 starts mid-stream). Respect invariant #14 for any call sites inside `handleSnapshot`/tick paths (use the sampled/guarded idiom already in that file).
- Lock: add `no-console` to `eslint.config.js` for `src/**` (allow `scripts/`, `tests/`) — the lint rule IS the regression test. Adding enforcement is the safe direction for eslint.config.js changes; still flag in the PR.
- Verify: inner loop. Netgate: no (do NOT touch ClientLogger's mechanism — it's the netgate-harness uniform overlay — only call sites). Commit.

---

## Workstream C — CI / enforcement automation

### C1. dependency-cruiser + knip configs + CI (M) — closes the MANIFEST_APPARATUS §2 acknowledged gap
- Coordination: MANIFEST assigns "DAG ruleset authored Phase 2" to the refactor engagement; Phase 2 hasn't started (change log empty) — doing it here is the shared deliverable. Append a note to `MANIFEST_APPARATUS.md` §3 Tier A.
- `.dependency-cruiser.cjs`: encode invariant #1 as a real module graph (core → only core/shared-types; server ↛ client; client ↛ server/`colyseus`; `src/client/render/worker` ↛ react/mui/zustand; shared-types pure). Meta-test: temporarily rename the canary `leak.ts.disabled` → `.ts` locally, confirm depcruise fails, revert.
- `knip.json`: report-only in CI first (`--no-exit-code` visible step); promote to blocking after triage.
- CI: both added to the `verify` job in `.github/workflows/ci.yml` after lint.
- Verify: `pnpm exec depcruise src` green locally; CI run. Netgate: no. Commit. Docs: root CLAUDE.md invariant #1 gains "and dependency-cruiser".

### C2. Coverage floor in CI (S) — do early (freezes the floor before D raises it)
- `vitest.config.ts` `coverage.thresholds` set to the recorded Phase-1 baseline (lines 34.49 / funcs 58.85 / branches 78.57 from `MANIFEST_DEBT_LOG.md`) minus ~1 point slack — a ratchet, not an aspiration. CI: add `pnpm coverage` to `verify`. Also mechanically enforces the Phase-2 engagement's own "coverage ≥ baseline" gate — note in its log. Netgate: no. Commit.

### C3. Bench in CI (M)
- `pnpm bench:check` already exists (`benchmarks/run-bench-check.ts`). Add a separate CI job (not in `verify` — runner variance), `continue-on-error: true` initially; promote to blocking after variance data (mechanism-not-margin philosophy; read `run-bench-check.ts` during implementation — if it's relative/budgeted, promote sooner). Netgate: no. Commit. Docs: invariant #8 footnote.

### C4. Dependency audit in CI (S)
- `verify` step: `pnpm audit --prod --audit-level=high` (continue-on-error if currently red; triage then tighten). Optional weekly `schedule:` workflow. Netgate: no. Commit.

### C5. Deferred (recorded, no step): invariant #14 alloc-lint stays the declared follow-up PR per root CLAUDE.md.

---

## Workstream D — Test-debt paydown

### D1. Zero-test subsystems (M, parallelizable)
- A0 covers `auth/`. Remaining: `src/server/identity/`, `src/server/stats/`, `src/server/transport/` (the untested files — channel + signaling already have tests), `src/server/workers/bundleWorker.ts`.
- Pattern: colocated vitest unit specs, hand-rolled mocks per the **`TransitOrchestrator.test.ts` gold standard** (server CLAUDE.md Testing patterns). `bundleWorker` may warrant the `dbWorker.integration.test.ts`-style real-boundary spec. One subsystem per commit. Netgate: no.

### D2. waitForTimeout paydown (T1) (L, long-running track)
- **D2a (S):** inventory commit — triage table per the CLAUDE.md taxonomy (infrastructural waits = legitimate; game-time waits = each needs a bespoke trigger or `waitForFunction` predicate) → `docs/refactors/wait-debt.md`.
- **D2b+ (M each):** fix worst offenders first, one spec-cluster per commit: `sync-health.spec.ts:24`, `interceptor-beam-stays-connected.spec.ts:86`, `input-throttle-drift.spec.ts:98`, `living-world.spec.ts` (180 s — expose `LivingWorldDirector`'s existing `controlIntervalMs` constructor option as a testMode knob via the 5-step "Adding a new primitive" recipe in root CLAUDE.md).
- Rule per commit: `waitForTimeout(N)` → `waitForFunction(predicate, { timeout: N })` + trigger; never net-increase a budget. Netgate: no (triggers that only set initial state don't touch tick behaviour; if one does, netgate applies).

### D3. Renderer parity/substitutability test (M) — strict prerequisite for B4's fallback commit
- E2E spec asserting worker path and main-thread path expose the same observable contract: join `galaxy-test` with `?worker=1` vs `?worker=0` (both already supported), assert the same render-mirror liveness signals via `data-*` probes (pixel screenshot only on the `worker=0` arm — worker path screenshots black). This is the LSP lock. Netgate: no. Commit.

### D4. Targeted SectorRoom integration breadth (M) — scoped to NOT collide with MANIFEST file #10
- Via `tests/integration/sectorRoom/harness.ts` + `_internals` + `connectActive` (the 2026-06-03 `client_ready` lesson — bare clients never activate), add only specs that double as locks for THIS plan:
  1. oversized-payload drop (locks A5),
  2. malformed-fire silent-drop + counter (locks invariant #3's documented behaviour at the integration layer),
  3. testMode join options on a non-testMode room are ignored (locks S6-adjacent gating inside SectorRoom).
- Note in `MANIFEST_DEBT_LOG.md` that file #10's baseline integration count rose. Netgate: no. Commit.

---

## Workstream E — Docs / ops

### E1. Env + security documentation (S) — accretes per-step; final sweep commit
- `.env.example`: add `NODE_ENV`, `PORT`, `DB_PATH`, `ALLOWED_ORIGINS`, `EQX_ENABLE_TEST_ROOMS`, `EQX_ALLOW_DEV_OVERRIDES` ("E2E only, never production"), `EQX_DEV_EVENTS_MAX`, `EQX_DISABLE_LIVING_WORLD`; `JWT_SECRET` marked production-required.
- New `docs/architecture/security.md` (invariant #10): threat model, the zod-strict boundary story, what each A-step enforces, recorded non-goals (WS-upgrade origin check, CSP at hosting layer, OAuth single-use trade-off).
- `src/server/CLAUDE.md` Thresholds: rate-limit budgets, Limbo cap, room-gating rule. Root CLAUDE.md: bespoke-trigger table pointer updates (A6). Commit.

### E2. Production deployment story (R6) (L) — only after A1/A6/A7/A9 (don't ship the known holes)
- `Dockerfile` (multi-stage build, Node 22, non-root, `DB_PATH=/data/eqx.db` volume) + `fly.toml` or generic compose; health check on `/healthz` (`ready` field exists, `index.ts:77-84`); SIGTERM stop signal (drain already implemented).
- `docs/ops/deployment.md` runbook: boot, required env, SQLite WAL-set volume/backup, pino-JSON log capture, rollback, `EQX_*` kill switches.
- CI: `docker build` step (build-only, no push) to catch Dockerfile rot.
- Lock: the CI docker-build step + documented local smoke (`docker run … curl /healthz` until `ready:true`). Netgate: no. Two commits: Dockerfile+CI, then runbook.

---

## Execution order & dependencies

1. **A0** (locks) → A2 / A3 / A4 / A9 in any order; A1 + A7 (middleware pair); **A6** (schedule when a full local e2e run is affordable); **A5** (schedule when a netgate run is affordable); A8.
2. **B1, B2** (server crash surfaces) → B3 → **D3 → B4** (parity strictly before fallback) → B5.
3. **C1–C4** any time; **C2 early** (freeze the floor before D raises it).
4. **D1, D2, D4** parallelizable, long-running; D2 is the largest time sink — timebox per offender.
5. **E1** accretes; **E2 last** (after A1/A6/A7/A9).

**Netgate-required steps: A5 and B4 only.** Everything else stays off the live loop by design — the security/robustness surface lives at the HTTP/bootstrap/process layer the netcode-focused apparatus never covered.

**Size summary:** S ×10 (A1 A4 A7 A8 A9 B1 B3 C2 C4 E1) · M ×11 (A0 A2 A3 A6 B2 B5 C1 C3 D1 D3 D4) · L ×3 (B4 D2 E2).

**Interaction with the MANIFEST_DEBT_LOG Phase-2 track:** no primary collision; surgical touches only — `App.tsx` (A3 param read; B3 wraps outside it), `ColyseusClient.ts` (B5 call-site swaps), `SectorRoom.ts` (A5 ~10-line schema bounds). Tests added here (A0, D4) RAISE that engagement's baselines — append notes to its change log. C1/C2 deliver tooling that engagement lists as its own prerequisites.

## Verification (end-to-end)

- Per step: inner loop (`pnpm typecheck && pnpm lint && pnpm test`); server-touching → `timeout 8 pnpm dev:server` (exit 143 OK); A5/B4 → `pnpm e2e:netgate`; A6 → full local `pnpm e2e` (background + log file per root CLAUDE.md playbook).
- Workstream-A acceptance: `NODE_ENV=production JWT_SECRET=<real> timeout 8 pnpm dev:server` boots; manual curl checks confirm 429 on auth hammering, no `Access-Control-Allow-Origin: *`, security headers present, joining `test-sector` fails at matchmaking, no `?token=` in the OAuth redirect.
- Workstream-E acceptance: `docker build` green in CI; local `docker run` reaches `/healthz` `ready:true`.
- Final: full green bar `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e && pnpm bench` + the new CI gates green on the PR.
