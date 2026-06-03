# Test-Coverage Audit & Determinism Refactor

> **Status:** Audit + roadmap (this document). The refactor *work items* below are the executable
> roadmap for follow-up sessions — each item is sized to be its own commit per the repo's
> commit-cadence rule. This document itself is the agreed deliverable; the code changes it
> describes are not yet applied.

---

## Context

The E2E suite has accreted into **75 Playwright specs** (`tests/e2e/`) on top of 23 integration
tests and three already-separated harnesses (`tests/perf/`, `tests/mobile-perf/`, `tests/diag/`).
A prior "e2e-rebuild" effort built excellent infrastructure — a four-tier taxonomy
(smoke/feature/gate/diag), per-test room isolation via `filterBy(['testId'])`, and bespoke
server-side gameplay triggers (`initialHull`, `initialShield`, `initialAngle`, `testTimeScale`,
`dronePoses`, `droneKinds`, `peacefulDrones`, `startHostile`) — but **the cleanup it promised was
never finished**. Three concrete debts remain, each matching a complaint in the audit request:

1. **Non-deterministic gameplay still ships.** `combat.spec.ts` joins `?room=sector` (the
   random-kind drone sandbox, *not* an engineering room), then "holds Space while rotating —
   ships are at random positions so we try 8 s" (`combat.spec.ts:186`), with a **conditional
   assertion** that silently passes if no hit lands ("Ships not facing each other within 8 s — no
   hit assertion possible"). The same spray-and-pray appears 5× in that file (lines ~186, 279,
   334, 420, 470) and once in `drone-destruction.spec.ts` ("random sweep may miss everything if
   RNG is unkind"). `respawn-cascade-input-routing.spec.ts` deliberately joins the **live
   `galaxy-sol-prime` room** with Living-World bots. These violate the suite's own stated policy
   (`playwright.config.ts:11` "no random inputs… use `?room=test-sector`") and root invariant #4/#9.

2. **Fixed-window measurement specs run inside `pnpm e2e`.** ~20 specs hold-fire or idle for a
   wall-clock window to gather heap/allocation/bandwidth/jitter numbers — e.g.
   `heap-snapshot-diff-mobile-emu.spec.ts` (360 s), `combat-heap-growth-fx-bisect.spec.ts` (420 s),
   `swarm-bandwidth.spec.ts` (30 s idle sample). They assert nothing a player would notice, dominate
   suite wall-clock, and are inherently variance-prone. A `tests/perf/` harness
   (`playwright.perf.config.ts`, run via `pnpm e2e:perf`) **already exists** to host exactly these.

3. **Zero parallelism + redundancy.** `workers: 1` (a shared dev server can't service concurrent
   sessions). Several specs overlap (two drawer specs, two ship-swap specs, a stack of
   prediction/sync drift specs already superseded by the netcode-health gate, two swarm-stability
   specs, feel-test-lockstep/feel-tuning superseded by a unit canary).

**Intended outcome.** A lean E2E suite where **every spec is deterministic** (engineering rooms +
scripted inputs + bespoke triggers, never luck or live galaxy state), **every spec has one
purpose**, **no spec waits out a fixed window to take a measurement** (those move to `tests/perf/`),
and **wall-clock drops sharply** via deletion of redundant specs and per-test fast-kill triggers.

**Decisions taken:**
- **Parallelism:** *Determinism-first, stay serial* (`workers: 1`). We do **not** build a
  multi-server pool now. Rationale captured below; it remains a clean future phase because the
  `filterBy(['testId'])` substrate is already in place.
- **Perf/measurement specs:** *Relocate out of the e2e suite* into `tests/perf/`
  (pure one-off investigation/bisect captures are **deleted**, not relocated).
- **Trimming:** *Aggressive* — delete redundant specs, rewrite weak (non-deterministic) ones.

---

## Guiding rules for every change below

- **Determinism without RNG seeding.** Two-ship combat needs no RNG: spawn shooter at a fixed
  pose with `initialAngle` aimed at a victim at a fixed offset, `initialShield: 0`, low
  `initialHull` → a held burst is a guaranteed, repeatable kill. Drone tests use `dronePoses` +
  `droneKinds` + `peacefulDrones` so outcomes never depend on AI timing. **No test may assert on
  an AI-driven or randomly-spawned outcome.** (Seeding the drone-AI / asteroid PRNG is recorded as
  optional backlog, *not* required — the primitives above already remove the non-determinism from
  every test we keep.)
- **No conditional assertions.** A test that can pass without exercising its assertion provides
  zero coverage. Every rewritten spec ends in an unconditional `expect(...)`.
- **State predicates, not `waitForTimeout`.** Replace fixed settles with
  `page.waitForFunction(predicate, { timeout: N })` — same `N` as a *deadline*, not as pacing.
  (196 `waitForTimeout` occurrences across 36 files; combat.spec.ts=36, robustness.spec.ts=27 are
  the bulk.)
- **Engineering room only.** Every retained spec joins a `testMode: true` room
  (`test-sector`, `test-sector-fast`, `feel-test`, `shield-test`, `hull-collision-*`, etc.) — never
  `?room=sector` or `?room=galaxy-*`.
- **One purpose per spec.** Multi-purpose files (combat's 12 tests) are split so each `test()`
  locks exactly one behaviour; mechanics with no remaining purpose are deleted.
- **Tests-first for any rewrite** (invariant #9/#13): the rewritten deterministic spec must fail
  against the *old* behaviour it claims to lock before the rewrite is considered done.

---

## Per-spec verdicts

Legend: **KEEP** (already deterministic & single-purpose) · **REWRITE** (make deterministic) ·
**MERGE** (fold into a sibling) · **RELOCATE** (move to `tests/perf/`, out of `pnpm e2e`) ·
**DELETE** (redundant or one-off capture).

### A. REWRITE — non-deterministic gameplay → deterministic engineering-room specs

| Spec | Problem | Action |
|---|---|---|
| `combat.spec.ts` | `?room=sector`; 5× spray-and-pray loops; conditional assertions; 36 `waitForTimeout` | Split into focused deterministic specs in a new `tests/e2e/combat/` dir, each joining `test-sector` (or `test-sector-fast`) with aligned spawns + `initialAngle` + `initialShield:0`: `beam-appears.spec`, `hull-decreases-on-hit.spec`, `victim-sees-death.spec`, `remote-laser-targetid.spec`, `remote-laser-range-truncation.spec`, `swarm-hit-detected.spec` (drone placed via `dronePoses` directly in the beam line). Hard assertions only. Delete the original. |
| `drone-destruction.spec.ts` | "random sweep may miss everything if RNG is unkind"; weak `<=` assertion | REWRITE: `dronePoses` places one peaceful drone in the beam line, `initialAngle` aims at it, hold fire until `data-swarm-detail` shows it destroyed (hard assert count decreased by exactly 1), deadline predicate. |
| `respawn-cascade-input-routing.spec.ts` | Joins live `galaxy-sol-prime` + Living-World bots | REWRITE onto an engineering room using `startHostile: true` (the primitive built for exactly this) to reproduce bot pressure deterministically; assert thrust moves ship after two sector picks. |

### B. RELOCATE — fixed-window measurement → `tests/perf/` (out of `pnpm e2e`)

These hold-fire/idle for a wall-clock window and report a number; they belong on the manual/
scheduled perf harness, not the regression suite. Move each into `tests/perf/` (it inherits the
base webServer + JWT setup; runs via `pnpm e2e:perf`). Where a spec carries a real budget assertion
(`swarm-bandwidth`, `heap-growth-gate`) keep the assertion in its relocated home.

`heap-growth-gate.spec.ts`, `combat-heap-growth.spec.ts`, `combat-allocation-profile.spec.ts`,
`combat-allocation-profile-hostile.spec.ts`, `heap-snapshot-diff.spec.ts`,
`heap-snapshot-diff-worker-off.spec.ts`, `heap-snapshot-diff-mobile-emu.spec.ts`,
`swarm-bandwidth.spec.ts`, `worker-ab-perf.spec.ts`, `worker-ab-perf-mobile-emu.spec.ts`,
`diag-mode-side-effect.spec.ts`, `mobile-perf-probe4.spec.ts`.

### C. DELETE — one-off investigation/bisect/repro captures (assert nothing durable)

These were investigation artefacts (their own docstrings say "investigation"/"repro"/"bisect"/
"comparison"/"observer effect"). Aggressive verdict: delete rather than relocate — they have no
ongoing regression value and any future investigation re-derives them.

`combat-heap-growth-fx-bisect.spec.ts` (420 s, 3-variant FX hypothesis test),
`autocapture-observer-effect.spec.ts` (2-arm observer-effect measurement),
`maxdrift-investigation.spec.ts`, `network-buffer-and-throttle-repro.spec.ts`,
`webrtc-vs-ws-recv-gap-comparison.spec.ts`, `webrtc-mobile-emulation-stutter.spec.ts`,
`webrtc-mobile-emulation-control.spec.ts`,
`spiral-disconnect-reconnect.spec.ts`, `spiral-in-pack-density.spec.ts`,
`spiral-joystick-flicker.spec.ts` (all three are fixed-interval sampling loops over a play window).

### D. DELETE/MERGE — redundant with a sibling or a faster unit/gate

| Spec(s) | Verdict | Why |
|---|---|---|
| `happy-path-ui-switch.spec.ts` | DELETE | `test.fixme()` known-flaky for months; `happy-path-switch-ship.spec.ts` (programmatic) locks the same surface deterministically. |
| `drawer-galaxy-map-open-close.spec.ts` + `drawer-galaxy-overview-spawn.spec.ts` | MERGE → one `drawer-galaxy.spec.ts` | Doc already flags consolidation; same drawer→galaxy-map flow, different assertions (close vs roster-card). |
| `feel-test-lockstep.spec.ts` + `feel-tuning.spec.ts` | DELETE | Superseded by `tests/unit/swarmInterpolation.smoothness.test.ts` (deterministic ~1 s) for the per-frame canary and by the netcode-health gate for corrections (doc's own "deferred reap" note). |
| `prediction-diagnostics.spec.ts`, `sync-diagnostics.spec.ts`, `sync-health.spec.ts`, `rotate-jitter.spec.ts`, `network-feel-combat.spec.ts` | DELETE | Drift/correction-rate measurement now owned by the netcode-health gate (`netHealthBudget.ts`) which is machine-insensitive. `rotate-jitter` is explicitly a "dump stats" diagnostic. Keep **one** idle-prediction lock (`prediction-idle-bounded`) — see KEEP. |
| `swarm-stationary-stability.spec.ts` | MERGE → `swarm-jitter.spec.ts` | Both assert drone/asteroid render position stays bounded; one parametrised spec covers moving + stationary. |
| `tidi-overlay.spec.ts` | MERGE → `swarm-tidi.spec.ts` | `swarm-tidi` is the full 4-stage TiDi acceptance gate; the overlay assertion (`data-sector-alert`) is one stage of it. |
| `laser-smoothness.spec.ts` | MERGE → `drone-laser-smoothness.spec.ts` | Local-ship vs drone beam-attachment; one spec with two cases, or fold the local case into a unit canary if one exists. Confirm during execution which is load-bearing. |
| `held-fire-continuous-damage.spec.ts` | DELETE | Currently `test.skip` pending a "2-client harness rewrite"; the deterministic combat split (group A) covers continuous-damage. |

### E. KEEP — already deterministic, single-purpose, engineering-room locks

Smoke: `boot`, `sector-alpha`, `scenarios/combat-lifecycle`, `ship-selection`, `layout-slots`,
`persistence-kill`, `weapon-switching`, `mobile-joystick-ship-swap`, `damage-number-lifetime`,
`join-warp-screen`, `spawn-select-flow`, `spawn-handshake`, `happy-path-switch-ship`, `shield-hud`.

Feature: `asteroid-shape`, `collision-events`, `configurable-arrival`, `galaxy-map-overlay`,
`galaxy-polish`, `halo-radar`, `warp-engage-cancel`, `wreck-render-probe`, `renderer-worker-probe`,
`ship-roster-panel`, `missile-frigate-homing`, `t-ship-no-self-collision`, `ramming-probe-armpit`,
`swarm-sleep`, `swarm-jitter` (+ stationary case), `swarm-tidi` (+ overlay stage),
`input-throttle-drift`, `prediction-idle-bounded`, `living-world` (outcome-gated, not perf-gated),
`drone-laser-smoothness` (+ local-laser case).

Gate: `netcode-health` (driven by `pnpm e2e:netgate`).

> Several KEEP specs (notably the combat split, `robustness.spec.ts`, `persistence-kill`) still
> carry `waitForTimeout` debt — convert those to state predicates as part of the same commit that
> touches each file (rule above), but they don't need structural change.

**Projected outcome:** ~75 e2e specs → **~33 deterministic e2e specs** + ~12 relocated to
`tests/perf/` + ~10 deleted, with the spray-and-pray and live-galaxy non-determinism eliminated.

---

## Harness work (enables the above)

1. **Verify/extend bespoke triggers.** All needed primitives already exist
   (`initialAngle`, `initialShield`, `initialHull`, `dronePoses`, `droneKinds`, `peacefulDrones`,
   `startHostile`, `testTimeScale`, `testId`+`filterBy`). Confirm `initialAngle` is surfaced in
   `TestClientOpts` (`tests/e2e/helpers/gameScenario.ts`) — the helper currently exposes
   `initialHull/Shield/injectLeak/testId` but not `initialAngle`/`dronePoses`. Add the missing
   fields so specs stop hand-rolling URL params (`combat.spec.ts` has its own `joinClientAt`).
   If a new "fire one deterministic burst and confirm a kill" pattern recurs 3+ times, add a
   `fireBurstUntilDead(shooterPage, victimPage, deadlineMs)` helper to `gameScenario.ts`.
2. **Consolidate the join helpers.** `combat.spec.ts` re-implements `joinClient`/`joinClientAt`
   against `?room=sector`. Route every spec through `launchTestClient` so room choice is
   centralised and "engineering room only" is enforced in one place.
3. **`tests/perf/` intake.** Confirm relocated specs run under `playwright.perf.config.ts`
   (`testDir: './tests/perf'`, 150 s per-test cap). Add any missing `pnpm e2e:perf` doc lines.
4. **Parallelism — documented, deferred.** Capture *why* `workers: 1` stays (shared
   server contention; historically failed at workers=3) and the future path (one
   `dev:server:nowatch` per worker on `2567+workerIndex`, `filterBy(['testId'])` already routes
   per-test rooms). No code change this round — determinism + deletion is the wall-clock win we
   bank now.

---

## Tier / config updates

- `playwright.config.ts`: drop the relocated/deleted specs from `FEATURE_SPECS`; add the new
  `combat/*.spec.ts` split files; update `SMOKE_SPECS`/`FEATURE_SPECS` to match the KEEP set.
- `docs/architecture/e2e-framework.md`: refresh the per-spec triage table + verdict roll-up to the
  new counts; record the spray-and-pray removal and the perf-relocation as completed Phase-2c work.
- `CLAUDE.md` "Running E2E Tests" / test-harness sections: note that measurement specs live in
  `tests/perf/` and are never part of `pnpm e2e`.

---

## Phased execution (each phase = its own green commit)

1. Relocate group B to `tests/perf/`; delete group C. Update config + e2e-framework doc.
   (Pure wall-clock reduction, no behaviour risk.)
2. Delete/merge group D. Update config + doc.
3. Rewrite group A deterministically (combat split, drone-destruction, respawn-cascade) — the
   load-bearing correctness work; tests-first per invariant #13.
4. `waitForTimeout`→predicate sweep on retained `@feature` specs (combat split, robustness,
   persistence-kill).
5. Harness consolidation (helper additions, `launchTestClient` routing).

---

## Verification

- **Inner loop (every commit):** `pnpm typecheck && pnpm lint && pnpm test`.
- **Determinism proof (group A):** run each rewritten combat spec **10×** in isolation
  (`pnpm e2e:feature tests/e2e/combat/<spec> --repeat-each=10 --reporter=line`) — must be 10/10
  green with no conditional skips. Tight Bash timeout per the CLAUDE.md E2E playbook (announce
  duration + cap before running).
- **Relocation proof (group B/C):** `pnpm e2e` no longer matches any relocated/deleted spec;
  `pnpm e2e:perf` runs the relocated set. Diff the spec count before/after.
- **Wall-clock:** capture `pnpm e2e:smoke` + `pnpm e2e:feature` total wall-clock before vs after;
  expect a large drop from removing the 360 s/420 s/30 s measurement specs.
- **Server boot smoke** after any `src/server/` touch (e.g. new trigger):
  `timeout 8 pnpm dev:server` prints `INFO: EQX Peri server started port: 2567`.
- **Netcode gate** if any group-A/harness change touches the live loop: `pnpm e2e:netgate`.
- **Tests-first evidence** for group A: each rewritten spec demonstrably fails against the old
  behaviour before the fix (paste the red run in the commit body).
