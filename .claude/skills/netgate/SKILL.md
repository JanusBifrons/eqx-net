---
name: netgate
description: Run the netcode-health gate (`pnpm e2e:netgate`) and report the verdict (pass/fail + offending metric + magnitude). The front door to Phase 1 of the e2e-rebuild plan — localises live-loop regressions without on-device testing.
allowed-tools: Bash
disable-model-invocation: true
---

# /netgate — netcode-health regression gate

You are running EQX Peri's machine-insensitive netcode-health gate to detect live-loop regressions between two refs (or HEAD-vs-`origin/main` by default). This is the canonical Phase-1 deliverable; it ships an outcome-only verdict, not a hypothesis.

## What this is for

- The user has made changes in `src/client/net/`, `src/core/prediction/`, `src/core/physics/`, the client render loop, snapshot decode/interpolate, mount aim, or `SectorRoom`'s tick/snapshot path — anything that could plausibly move `data-pred-stats`.
- The deterministic suite (typecheck/lint/unit/integration/bench) is GREEN, but green-deterministic is **not** a playability signal (root CLAUDE.md invariant #8 corollary; 2026-05-19 incident).
- The user wants to know: *is HEAD playable, relative to a known-good baseline, on this box?*

## How it works

The deterministic suite (typecheck + lint + unit + integration + bench) verifies logic in isolation; it is **not** a playability signal. The netgate is the live-loop check the deterministic suite was never trying to be: it joins a real Colyseus room over an injected mobile-network profile and compares the `data-pred-stats` HEAD writes against a same-session baseline arm on the same box.

**Scenarios — it gates HEALTH, never correctness.** The catalogue is `tests/netgate/scenarios.ts` (`SCENARIOS[]`, the single source of truth for BOTH the spec and CI selection). `core` (`feel-test-25`, 25 drones, gated) is the foundational local-feel check. `autopilot` (`cut-field-test`, a fighter flying a server route round a rim rock on the helm, gated) guards the autopilot inputs; it fires on nav/helm paths. Load-bearing distinction: every gated metric measures the **LOCAL PLAYER's prediction reconciliation**, so the netgate CANNOT detect a structures/scrap *correctness* regression; that is gated DETERMINISTICALLY (`BinarySwarmBroadcast`/`BinarySwarmDecoder` tests, `tests/unit/swarmWireRoundTrip.test.ts`, `scrapOnDeath`/`structureScenario`/`structureGrid` integration), and structure/scrap load cost is measured by the perf scenes. Galaxy is deliberately out (client-render path, covered by deterministic E2E).

**When required (invariant #8 corollary).** Any PR matching a scenario's `triggerGlobs` in `scenarios.ts` — `core`'s set is SHARED live-loop (`src/client/net/`, `src/core/prediction|physics/`, `WeaponMountController`, `SectorRoom`/`SnapshotBroadcaster`/`EntitySyncRouter`, `swarmWireFormat`, `messages/`) **∪ STRUCTURE** (`src/server/structures/`, `src/core/structures/`, `structureKinds.ts`) **∪ SCRAP** (`ScrapSpawner.ts`, `scrapCollider.ts`, `scrapConstants.ts`). CI does the selection itself (`tests/netgate/select-scenarios.mjs`, **fail-closed**: an error / empty / API-truncated / unenumerated-live-loop-path diff runs ALL gated scenarios; only a provably non-live-loop diff skips). You don't predict from `git diff` — the gate's pass/fail IS the verdict.

**Running it by hand.**

- `pnpm e2e:netgate` — defaults: scenarios `core`, baseline `origin/main`, head = working tree, primary mobile profile (≈120 ms RTT ±60 ms, 0 % drop), 4 interleaved reps `A/B/A/B/A/B/A/B`. `NETGATE_SCENARIOS=<csv>` selects scenarios (each is its own Playwright `test()`); the netgate `workflow_dispatch` has a `scenarios` input. `NETGATE_PORT_OFFSET=N` moves every port when another session is active: server 2567+N, proxies 2568/2569+N, Vite arms 5274/5273+N; the Playwright child gets `EQX_E2E_PORT_OFFSET=N` (plus explicit `PLAYWRIGHT_SERVER_URL`/`PLAYWRIGHT_BASE_URL`), so global setup mints its token from the gate's server. Ports resolve in `tests/netgate/netgatePorts.ts` (unit-locked). Pick N so none of those ports is taken.
- The driver (`tests/netgate/run-netgate.ts`) creates two git worktrees under `.claude/worktrees/netgate-{baseline,head}` (incremental — preserves `node_modules` across runs), boots two `vite` dev servers with HMR disabled on both, starts a per-arm HTTP+WS latency proxy, and runs `tests/e2e/netcode-health.spec.ts` interleaved on each. ~6–8 min for a single-scenario acceptance run.

**What it gates (single source of truth: `tests/netgate/netHealthBudget.ts`).** `ticksAhead`, `maxDriftUnits`, `meanDriftUnits`, `droppedSnapshotsRecent` — each metric uses a **relative AND absolute** AND-gate (head must be both worse than baseline by margin AND past the documented playable ceiling to fail). Improvements (ratio ≤ 1) can never fail. Liveness preconditions (`snapshotCount > 40`, `diagEnabled === false`) are a DISTINCT result channel — "the gate did not validly run" must never read as "healthy."

**Print-only (NOT gated).** `rollingCorrRate` (`main` vs identical `main` FAILED the gate, 0.45 vs 0.95; same-code spread 0.3–0.95 exceeds its 0.6 ceiling). `snapshotJitterMs` and `rtt*` are proxy-jitter-dominated — their baseline variance over identical-code reps (19.5–130.8 ms for jitter; 6.7× spread) exceeds any sensible margin. Same disqualifier the plan used to exclude `rtt*` at the outset. Re-adding either without solving the injected-jitter confound is a deliberate, reviewed change.

**The measurement-harness overlay.** The driver copies the working tree's `ClientLogger.ts` + `vite.config.ts` onto every worktree before booting its dev server — the measurement harness must be uniform across arms; each ref keeps its own netcode. Booting a pre-Phase-0a ref naïvely makes the diff a harness mismatch, not a netcode delta. Don't bypass it.

**Auto-retry ONCE, then BELIEVE it.** The netgate is a relative measurement and is variance-prone on contended hosted runners. The separate **`auto-retry.yml`** workflow (`workflow_run`-triggered) **auto-re-runs a failed CI/Netgate run's failed jobs exactly once on a fresh runner** (`run_attempt == 1` guard — `rerun-failed-jobs`). It MUST be a separate workflow: `rerun-failed-jobs` is rejected (HTTP 403 "workflow is already running") if called from a job INSIDE the still-running run, and `workflow_run` only fires from the default branch (so it takes effect once merged to main). This is NOT retry-until-green: a failure that **survives the retry (attempt ≥ 2) is LEGITIMATE.** Treat it as a real regression — **investigate the netcode; do NOT report it as a "host flake" or "the box."** Deflecting a surviving failure to the host is the exact reflex this policy exists to stop. When a surviving RED really is environmental, the fix is a *mechanism* one (a quieter/self-hosted runner, a baseline-sanity liveness precondition), surfaced as such — never a shrug.

## Invocation

The user typed `/netgate` (or `/netgate <baselineRef> <headRef>`). Arguments:

- `$1` (optional) — baseline ref (default `origin/main`)
- `$2` (optional) — head ref (default working tree)

## What to do

1. **Pre-flight check.** Confirm:
   - We're inside a git repository (`git status` succeeds).
   - The working tree is clean OR the user has accepted that `head = working tree` includes uncommitted changes. If neither, ask once before running.
   - The user has been told *up front* that this is a 6–8 minute multi-arm run (announce timing per the timeout protocol in root CLAUDE.md).

2. **Run the gate.** Use `Bash` with `run_in_background: false` and an explicit `timeout: 720000` (12 min — ~50 % cushion over the ~6–8 min expected runtime). Redirect output to a log file so the verdict survives any harness truncation:

   ```bash
   pnpm e2e:netgate <baseline> <head> 2>&1 | tee .claude/netgate-last.log; echo "EXIT=$?"
   ```

   (Omit args when defaults are wanted.)

3. **Parse the verdict.** Read the log file. The gate's output stanza is:

   ```
   === netcode-health verdict (medians over N reps) ===
     baseline: { ...stat block... }
     HEAD    : { ...stat block... }
     [PRECONDITION FAILURES: ...]    ← if any (a DISTINCT result; "the gate did not validly run")
     [REGRESSION <metric>: HEAD <h> vs baseline <b> ratio=X ...]   ← per failing metric
     PASS=true|false
   ```

   The single source of truth for the budget thresholds is `tests/netgate/netHealthBudget.ts`.

4. **Report.** Three branches:

   - **PASS=true.** "Netgate green. HEAD ≈ baseline within margin on this box. The on-device pain (if any) reproduces as *baseline-equivalent*, i.e. a pre-existing issue rather than a HEAD regression — investigate as a scoped fix, not a wrap-up rollback." Include the baseline + HEAD stat blocks verbatim.

   - **PASS=false, with REGRESSION lines.** "Netgate RED on `<metric>` (HEAD <h> vs baseline <b>, ratio Xx, beyond the `MARGIN=Y, EPS=Z, CEIL=W` AND-gate). HEAD has a real netcode regression vs baseline. Suggested next step: `git bisect run pnpm e2e:netgate` between `<baseline>` and `<head>` — the gate is a deterministic pass/fail script so bisect narrows the offending commit automatically." Include the offending metric line(s) and the baseline + HEAD stat blocks.

   - **PRECONDITION FAILURES (snapshotCount, diagEnabled, etc.).** "Netgate did not validly run — `<precondition>`. This is NOT a healthy verdict; it means the measurement environment was wrong (e.g. `?diag=1` slipped on, the room never spawned, dev server didn't boot). Diagnose the precondition before re-running. The verdict is undefined."

5. **Don'ts (load-bearing rules — do NOT violate):**
   - **Do NOT predict from `git diff`.** "Those commits don't touch netcode so it's probably fine" is the falsified cop-out class — the gate exists so we never make that prediction. Report the metric, not a theory.
   - **Do NOT widen a margin to silence a flake.** If the gate flakes, run `main`-vs-`main` ≥ 3× to characterise variance and fix the *mechanism* (or demote the metric to print-only — like `snapshotJitterMs`); never the threshold.
   - **Do NOT measure with `?diag=1`.** The Phase 0a `?diag=0` override is the gate's whole "measure production code" assertion. The spec asserts `__eqxDiagEnabled === false` before reading stats.
   - **Do NOT run the gate in the inner loop.** It creates worktrees and takes 6–8 minutes. The deterministic suite is the inner loop; the netgate is a conditional outer gate.

## Clean up afterwards

When the run ends (pass or fail): stop the servers, proxies and headless Chrome it started (`netstat -ano | findstr ":2567 :5173 :2767 :5373" | findstr LISTENING`), delete its scratch files and logs once read, and trim any status note in auto-memory. See `docs/ops/agent-workflow.md` "Clean up at every stage".

## On flakes

If the gate flakes (PASS state varies across identical invocations), the answer is to characterise the variance with `main`-vs-`main` ≥ 3×, then either:
- demote the unstable metric to print-only (like `snapshotJitterMs` already is), OR
- fix the underlying mechanism.

Never widen a `MARGIN/EPS/CEIL` to "smooth over" the flake. The anti-flake architecture is mechanism, not margin.

## References

- Plan: `C:\Users\alecv\.claude\plans\i-want-you-to-lively-tulip.md` (Phase 1 + Mechanism 1–4)
- Budget module (single source of truth): `tests/netgate/netHealthBudget.ts`
- Driver: `tests/netgate/run-netgate.ts`
- Spec: `tests/e2e/netcode-health.spec.ts`
- Root CLAUDE.md: "Netcode-health gate" section (the short rules; this file holds the full rules and mechanics)

## History

- **Why it exists (2026-05-19).** The Phase-1 deliverable of the e2e-rebuild plan (`C:\Users\alecv\.claude\plans\i-want-you-to-lively-tulip.md`). The 2026-05-19 wrap-up shipped with every deterministic gate green and was unplayable on-device — `docs/LESSONS.md` 2026-05-19/20 has the full incident.
- **Multi-scenario (plan: misty-teapot).** The print-only `structures-load` / `scrap-load` scenarios were removed (wrap-up W4, 2026-11-09): they gated nothing and never met their promotion bar. The structure/scrap server paths were a **false-negative hole** in the old hand-maintained regex (a pure structures/scrap logic change SKIPPED the gate); they now correctly fire `core`.
- **`rollingCorrRate` demoted to print-only (2026-11-05)** after `main`-vs-`main` failed it.
- **Retry policy (2026-06-15)** corrected the earlier "never retry, only characterise" purism: empirically every recurring RED cleared on a fresh-runner re-run, so that stance was bad advice in practice. Widening a margin to silence a flake stayed forbidden (mechanism, not margin).
- **`?diag=0` (Phase 0a).** Playwright sets `navigator.webdriver=true`, which auto-enables diag; without the `?diag=0` URL override + `__resetDiagCache()`, every spec measured an instrumented build no player ever runs.
