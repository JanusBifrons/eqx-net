# Hostile Review — Health, Security & Robustness Remediation Plan (`squishy-canyon`)

**Reviews:** `docs/plans/health-security-remediation-squishy-canyon.md`
(authored 2026-06-09 against commit `b272bc6`, currently on branch
`claude/codebase-review-plan-qwv0p0`).

**Reviewed against:** `claude/security-plan-hostile-review-3bnoa6` @ HEAD `011e7d2`
(2026-06-10). The only source changes between the plan's baseline and this tree
are `.github/workflows/ci.yml` (CI job split) and a batch of
`tests/integration/sectorRoom/*` migrations to `connectActive` — both of which
land squarely in the plan's blind spots.

**Method.** Three adversarial reviewers ran in parallel, each told to assume
every claim was wrong until current code proved it right, and to verify every
`file:line`. Slices: (1) Security S1–S9 + Workstream A; (2) Robustness R1–R7 +
CI C1–C5 + Workstream B/C; (3) Test-hygiene + Workstream D + plan coherence.
Every claim below is backed by a direct file read or grep against `011e7d2`.

---

## Bottom line

The plan is **still relevant and worth executing — its security spine is
intact — but it must NOT be run verbatim.** All 9 security findings are live and
correctly cited. But the robustness and CI sections have aged: the codebase
already shipped a React ErrorBoundary and persistence-worker error/exit
observability, and CI was restructured out from under every Workstream-C
instruction. There is also one arithmetic defect and one verification-protocol
gap that would let two steps' regression locks go un-run.

Roughly **2 B-steps dropped/rescoped, all of Workstream C re-pointed, A5
expanded, and the integration-test verification gap closed** brings it current.

---

## Rock-solid — execute as written

- **All 9 security findings (S1–S9) CONFIRMED live**, byte-identical to the
  baseline: hardcoded JWT fallback (`jwt.ts:3-5`), CORS `*` (`index.ts:34`), no
  auth rate-limiting, `?token=` in the OAuth redirect (`authRouter.ts:150`),
  ungated test/engineering rooms, in-memory CSRF `Map` (`authRouter.ts:100`),
  unbounded zod fields, no security headers, uncapped `LimboStore`. Workstream A
  is fully feasible — `clientIp()` (`authRouter.ts:28-32`), the
  `diagRouter.test.ts` pattern, and `LimboStore.test.ts` all still exist.
- **R1** (no `uncaughtException`/`unhandledRejection` guards), **R5** (zero-test
  subsystems), **C1–C4** (bench / depcruise / knip configs / coverage
  thresholds / `pnpm audit` all genuinely absent from CI), and **T1's
  144 `waitForTimeout` + 46 `test.setTimeout`** — all measured **exactly
  accurate**.
- "Healthy, don't touch" claims on **SQL parameterization** (every statement is
  `db.prepare()` with `?` placeholders) and the **SIGTERM/SIGINT drain**
  (`index.ts:743,771,777,792-793`, 10 s hard deadline) — verified correct.

---

## WRONG or overstated — fix before executing

| Plan item | Reality on `011e7d2` | Action |
|---|---|---|
| **R2 / B3** — "No React ErrorBoundary; `App.tsx` unwrapped" | **FALSE.** `ErrorBoundary` exists (`src/client/components/ErrorOverlay.tsx:87`, with `getDerivedStateFromError` + `componentDidCatch`→`pushError`) and already wraps the tree (`App.tsx:760`–`793`). | **Drop B3**, or reduce to "route the existing boundary through ClientLogger" (it currently logs via `pushError`, not ClientLogger). |
| **R4 / B2** — "no `worker.on('error')`; SQLite failures vanish" | **Half false.** `WorkerBackedSink.ts:118,126` already has `on('exit')`/`on('error')`→`logger.error`, plus an `exited` flag logging `criticalSinkLost` (`:134`) and WAB-cap-exceeded (`:139`). The five silent `catch {}` are real but live on **boot-time hydrate paths** (`PersistenceWorker.ts:128,137,203,258,290`), not the hot persist path. | **Rescope B2** to "harden the 5 hydrate catches + add `/healthz` persistence counters." Drop the "add `worker.on('error')`" deliverable — already present. |
| **R3 / B4** — "render-worker crash unobservable" | **Partial.** `WorkerRendererClient.ts:124` has `worker.onerror` (but `console.error` only — no ClientLogger/bus); **no `onmessageerror`**; **no runtime fallback to main-thread `PixiRenderer` on worker death** (the PixiRenderer path exists only as a *construction-time* choice for non-OffscreenCanvas browsers, `:582`). | Reframe B4's observability half as "upgrade existing `onerror` → ClientLogger+bus, add `onmessageerror`." The missing crash-fallback half **stands as written**. |
| **R6** — ".env.example missing most env vars" | **It exists** (6 vars incl. `JWT_SECRET`); missing `NODE_ENV/PORT/DB_PATH/ALLOWED_ORIGINS/EQX_*`. | Reword to "incomplete" — E1's append list is correct. Deploy story (Dockerfile/workflow/runbook) genuinely absent (R6/E2 stand). |
| **R7 / B5** — "15 `console.*` in `ColyseusClient.ts`" | Actually **12**. src/client total **29** (within "~"); `authRouter.ts` **2** at `:122,153` ✓. | Correct the count (slightly less B5 call-site-swap work). |

---

## CI drift since `b272bc6` (all three reviewers flagged independently)

`ci.yml` was split. The single `verify` job that used to run tests is gone:

- `verify` (`ci.yml:12`) — typecheck, lint, **build only**. No tests.
- `unit-tests` (`ci.yml:37`) — `pnpm run test`.
- `integration-tests` (`ci.yml:61`) — `pnpm run test:integration` (**new required
  job**; integration specs previously never ran in CI).
- `e2e-smoke` (`ci.yml:98`) — sharded `@smoke` Playwright.

**Every Workstream-C step says "add to the `verify` job."** That mental model is
now stale:

- **C3 (coverage)** is **mis-targeted** — `pnpm coverage` is a test run; it
  belongs in `unit-tests` (`:37`), not the build-only `verify`. (Its scope
  excludes `*.integration.test.ts`, mirroring `unit-tests` — reinforcing the
  placement.)
- **C1 (bench)** — **survives**: it already prescribes a *new* job, not `verify`.
  Just confirm it lands as a sibling of `unit-tests`/`integration-tests`.
- **C2 (depcruise+knip) / C4 (audit)** — defensible as steps in the build-only
  `verify` (static, fast, non-flaky), but the plan's rationale text ("the
  `verify` job ... after lint" / "the single verify job") is wrong and must be
  reworded.
- **Bonus:** the new required `integration-tests` job moots any plan assumption
  that integration tests don't run in CI — and is directly relevant to the
  verification gap below.

---

## Plan-internal defects

1. **Arithmetic error (hard).** The size summary says `S ×10
   (A1 A4 A7 A8 A9 B1 B3 C2 C4 E1)`, but **A5 is tagged `(S)` in its header and
   was dropped from the list.** Real total = **25 steps, S ×11** (add A5).
   Conspicuous: A5 is one of only two netgate-required steps.
2. **Verification-protocol gap (most important).** The inner loop and final
   green bar use `pnpm test` = `vitest run`, which **excludes
   `tests/integration/**`** (`vitest.config.ts:78`); those run only via
   `pnpm test:integration`. But **A5's lock** ("+ a `tests/integration/sectorRoom/`
   case") and **all of D4** live in `tests/integration/`. A future agent
   following the stated loop would write those locks, run the loop, see green,
   and commit **without ever executing them** — the exact "silently-RED,
   invisible in CI" failure mode the freshly-added `integration-tests` job was
   created to fix. **Add `pnpm test:integration` to A5/D4 verification and to the
   final green bar.** (B2's `dbWorker.integration.test.ts` is safe — it lives
   under `src/server/db/` and matches `src/**/*.test.ts`, so plain `pnpm test`
   runs it; the plan's parenthetical there is correct.)
3. **Unencoded ordering edges (soft).** A5↔D4 (A5's integration lock physically
   lives inside a D4 step, yet A5 is A-first and D4 is a long-running parallel
   track — if A5 ships first, its lock doesn't exist yet) and A9→A6 (A6's
   production-boot check "needs `JWT_SECRET` set once A9 lands"). Add the edges,
   or move A5's integration lock authorship into A5 itself.
4. **S5 under-reports.** Beyond `clientShotId`/`targetSectorKey`, these inbound
   strings are also unbounded on the wire: `FireMessageSchema.slotId`
   (`clientMessages.ts:55`), `RemoveStructureSchema.id` (`:131`),
   `SelectEntitySchema.id` (`selectionMessages.ts:48`). A5 should bound these too
   or the finding is only partially closed.
5. **Stale "healthy" count.** "12 `onMessage` handlers" is actually ~15
   (`SectorRoom.ts:1730-1882`) — all still `.strict()`-validated with
   `safeParse`-and-drop (webrtc/selection/structure schemas included), so the
   *substance* holds, but a future auditor told "12, all good" might skip
   re-auditing the 3 newer pairs. Re-anchor to "all current handlers."

---

## Stale specifics to correct in the plan text

| Plan reference | Correct value on `011e7d2` |
|---|---|
| S6/A6 room-`define()` range `index.ts:214-656` | `index.ts:207-650` |
| `EQX_ALLOW_DEV_OVERRIDES` at `SectorRoom.ts:163` | line **164** |
| `interceptor-beam-stays-connected.spec.ts:86` | under `tests/e2e/combat/` |
| D1 transport "untested files" | the one untested file is `webrtcChannelFactory.ts` (channel + signaling already have tests) |
| `ColyseusClient.ts` console.* count `15` | **12** |

---

## What did NOT change (reassurance)

- No S1–S9-cited source file changed between `b272bc6` and `011e7d2` — only
  `ci.yml`, `src/server/CLAUDE.md`, and 12 `tests/integration/` files.
- The fresh `connectActive` migration **reinforces** D4: it established the
  "new integration specs use `connectActive` + assert on active hulls" pattern
  that D4 prescribes. D4's primitives all exist — `connectActive`
  (`harness.ts:105/230`), `room._internals` (`SectorRoom.ts:660`), the
  `galaxy-test` room (`index.ts:621`), `?worker=0/1`
  (`gameSurfaceBootstrap.ts:38`).
- D1 zero-test claims (`identity/`, `stats/`, `workers/bundleWorker.ts`) hold.
- The 144 / 46 test-debt headline is exact; `SectorRoom.ts` is 3869 LOC and
  `ColyseusClient.ts` is 4932 LOC, both matching the plan's "~3.9k / ~4.9k".
