# E2E framework — tier taxonomy + per-spec triage

**Status:** Phase 0b of the e2e-rebuild plan (`C:\Users\alecv\.claude\plans\i-want-you-to-lively-tulip.md`). Phase 2 acts on this doc — tagging specs into Playwright projects, moving `@diag` specs out of CI, replacing `waitForTimeout` settles with state predicates, raising the suite timeout.

## Why this doc exists

On 2026-05-19 a 6-commit wrap-up shipped with the full deterministic suite green (typecheck 0 / lint 0 / 1031 unit / integration / boot / bench) and was unplayable on-device. Phase 1 of the e2e-rebuild plan built the netcode-health gate (`pnpm e2e:netgate`) to answer the playability question the deterministic suite was never trying to answer; this doc Phase-0b — the prerequisite for Phase 2's framework restructure — classifies every existing E2E spec so the runner can ship a coherent four-tier story instead of one unsorted bag of `tests/e2e/*.spec.ts`.

The cost of the current bag-of-specs setup is concrete: every E2E run shoulders the full ~50-spec wall-clock, every `pnpm e2e` includes 6 specs that explicitly assert nothing (capture-only `*-probe`/`*-capture`/`*-diagnostic` specs), 29 of those specs trip lint with "unused eslint-disable" comments that mask real warnings, and CI's `timeout-minutes: 15` is at the same wall-clock as the suite ceiling — a single slow spec on a CI runner can abort the lot.

## The four tiers

| Tier | What it is | Where it runs |
|---|---|---|
| `@smoke` | Fast deterministic critical-path locks. The "did the app start, can a player join, do core flows work" floor. Smoke is what fails *first* in CI so a regression surfaces in ≤2 min. | `pnpm e2e:smoke` (subset of `pnpm e2e`, runs first). CI step 1. |
| `@feature` | Per-surface exhaustive locks. Wider coverage, slower per spec, often 30 s edge cases. Where most of the suite lives. | `pnpm e2e` (runs `@smoke` first, then `@feature`). CI step 2. |
| `@gate` | Machine-insensitive engineered gates that compare HEAD vs a baseline ref on the same box in the same session. Currently: the netcode-health gate (Phase 1). | `pnpm e2e:netgate` (the driver — `pnpm e2e:gate` runs the spec standalone, which skips without the driver's env). Required for live-loop-touching changes; not in default CI yet (Phase 5 wires it). |
| `@diag` | Dev-capture artefacts that assert nothing meaningful — they collect CDP traces, frame markers, DOM dumps, etc. for offline analysis. Useful for the developer who's actively investigating. Useless as a regression signal because they don't fail when the surface regresses. | Manual only. Moved to `tests/diag/`; excluded from default Playwright `testDir`. Never in CI. |

### Tier criteria (what gets the tag)

**`@smoke`** if all of:
- single concern, ≤ ~3 tests per file
- deterministic environment (`?room=test-sector` engineering rooms, scripted inputs, state predicates not `waitForTimeout`)
- ≤ 30 s wall-clock (the global default cap; smoke MUST stay under it without the per-test `setTimeout` extension)
- covers a critical-path failure mode (boot, join, spawn, basic combat, ship switch, persistence read-after-write, mobile input, the worker-boundary probe-page locks)

**`@feature`** otherwise, if the spec ASSERTS specific behaviour (not just captures data) and locks a surface that could regress in isolation. Includes the multi-test surface specs (combat, robustness, weapon-switching), the integration smokes that need extended timeouts (`feel-test-lockstep`/`feel-tuning`, `swarm-tidi`, `tidi-overlay`, `swarm-bandwidth`), and the per-surface UI/wire locks.

**`@gate`** if the spec is meaningless without a baseline comparison — it does not run usefully standalone, only via a driver that supplies the baseline arm. Currently exactly one spec (`netcode-health.spec.ts`) which `skip`s itself when `NETGATE_ARMS` is unset.

**`@diag`** if the spec's own docstring or test title says "capture", "probe", "diagnostic", or "data only, not a regression lock" — i.e. it's instrumentation, not assertion. These are kept (often invaluable for debugging) but moved to `tests/diag/` and excluded from CI so they don't bloat the suite wall-clock.

## Per-spec triage table

| Spec | Tier | Surface locked | Lock vs capture | Runtime | Verdict |
|---|---|---|---|---|---|
| `boot.spec.ts` | `@smoke` | Vite dev-server renders the splash heading. The single most basic "is anything alive" check. | LOCK | ⚡ fast | KEEP |
| `sector-alpha.spec.ts` | `@smoke` | The critical-path net-stack lock — connection, two-client isolation, movement broadcast, server-authoritative state, identity, physics worker. 6 describes. | LOCK | 🚶 medium | KEEP |
| `scenarios/combat-lifecycle.spec.ts` | `@smoke` | Spawn-at-URL-params, kill-target, SHIP DESTROYED alert, respawn at initial position, hull decrease propagation. | LOCK | 🚶 medium | KEEP |
| `ship-selection.spec.ts` | `@smoke` | Ship-picker on galaxy-map — UI critical path for choosing a ship. | LOCK | 🚶 medium | KEEP |
| `layout-slots.spec.ts` | `@smoke` | UI layout invariants — top/bottom/left/right slot contracts. | LOCK | ⚡ fast | KEEP |
| `persistence-kill.spec.ts` | `@smoke` | Kill recorded in `player_kills` table, queryable via `/dev/stats`. The persistence read-after-write floor. | LOCK | 🚶 medium | KEEP |
| `weapon-switching.spec.ts` | `@smoke` | 6 tests: weapon selector boxes visible, `1`/`2`/`Q` cycling, projectile vs beam, ghost cleanup, switch-while-firing. The keyboard/HUD floor for combat input. | LOCK | 🚶 medium | KEEP |
| `mobile-joystick-ship-swap.spec.ts` | `@smoke` | In-game ship swap does NOT leave a stale joystick. Mobile critical-path regression. | LOCK | 🚶 medium | KEEP |
| `damage-number-lifetime.spec.ts` | `@smoke` | The worker-boundary probe-page lock for damage-number drain — catches the structured-clone bug class. Canonical "test where the bug LIVES" pattern (invariant #13). | LOCK | 🚶 medium | KEEP |
| `join-warp-screen.spec.ts` | `@smoke` | Join → WarpScreen visible immediately, hides when ready; viewport rotation reaches the worker; post-warp UI is interactive. The mobile entry-flow floor. | LOCK | 🚶 medium | KEEP |
| `spawn-select-flow.spec.ts` | `@smoke` | Post-auth spawn-select → click sector → game surface mounts. Both engineering and galaxy sector variants. | LOCK | 🚶 medium | KEEP |
| `happy-path-switch-ship.spec.ts` | `@smoke` | Switch-ship dispatch keeps the local ship rendered. The ship-swap-doesn't-break-render floor. | LOCK | 🚶 medium | KEEP |
| `happy-path-ui-switch.spec.ts` | `@smoke` | UI happy-path — drawer → Galaxy tab → roster card → Spawn renders the new ship. The full UI-driven ship-spawn flow. | LOCK | 🚶 medium | KEEP |
| `shield-hud.spec.ts` | `@smoke` | Shield/Hull HUD wiring is live end-to-end on join (Zustand → data attributes → ShieldHullBar). Explicit "non-flaky HUD-surface smoke" per its own docstring. | LOCK | 🚶 medium | KEEP |
| `asteroid-shape.spec.ts` | `@feature` | 3 tests: roster integrity (every asteroid in mirror), visible variety (≥2 distinct radii), cross-session determinism (entityId → radius stable). | LOCK | 🚶 medium | KEEP |
| `combat.spec.ts` | `@feature` | 12 tests covering hitscan beam, fire pipeline, projectile travel, remote-beam observer, ship-destroyed, remote-laser targetId, TTL clear, swarm hit, range truncation. The exhaustive combat-mechanics regression lock. | LOCK | 🐢 slow (36 `waitForTimeout`) | KEEP — Phase 2c predicate-cleanup target |
| `collision-events.spec.ts` | `@feature` | Stage-2: collision_resolved events applied during real gameplay. | LOCK | 🚶 medium | KEEP |
| `configurable-arrival.spec.ts` | `@feature` | Mobile-only arrival picker — mode toggle, per-mode disabled state, blur clamp + toast, persistence. UI surface; wire/server behaviour locked in vitest. | LOCK | 🚶 medium | KEEP |
| `drawer-galaxy-overview-spawn.spec.ts` | `@feature` | Drawer → Show galaxy map → roster card opens detail modal (real clicks). | LOCK | 🚶 medium | KEEP, consolidate with next |
| `drawer-galaxy-map-open-close.spec.ts` | `@feature` | Drawer → Show galaxy map → X close: stays interactive, no double-mount. | LOCK | 🚶 medium | KEEP, consolidate with previous |
| `drone-destruction.spec.ts` | `@feature` | Drone destruction: holding fire eventually reduces drone count. | LOCK | 🚶 medium | KEEP |
| `drone-laser-smoothness.spec.ts` | `@feature` | Drone laser count stays bounded and origins track drone pose. The integration smoke for the drone-laser-jitter fix. | LOCK | 🚶 medium | KEEP |
| `feel-test-lockstep.spec.ts` | `@feature` | Drone render smoothness — 25-drone pack tracks, never pins/lurches. Per its own docstring: "INTEGRATION SMOKE, not per-frame canary" — the real canary is `tests/unit/swarmInterpolation.smoothness.test.ts`. Kept for the live-server cross-validation only. | LOCK (integration smoke) | 🐢 slow (60 s timeout) | KEEP — flagged as superseded by unit canary |
| `feel-tuning.spec.ts` | `@feature` | Stage-1 halfLife ≤ 25 ms correction lerps; slow-down tune Fighter held-thrust displacement band. Now superseded by `netcode-health.spec.ts` for the corrections aspect, but the slow-down tune lives here. | LOCK | 🚶 medium | KEEP — flagged superseded for corrections; slow-down tune still load-bearing |
| `galaxy-map-overlay.spec.ts` | `@feature` | Galaxy Map B (Pixi overlay) — React-side toggle (button aria-pressed, `M` keyboard). Pixi-side draw covered by core unit. | LOCK | 🚶 medium | KEEP |
| `galaxy-polish.spec.ts` | `@feature` | Galaxy-map-screen UI regression — no marketing banner, no FullscreenCTA, zoom default 0.7. | LOCK | 🚶 medium | KEEP |
| `halo-radar.spec.ts` | `@feature` | Halo radar arrows appear when POIs off-screen; dataset attribute present and numeric every frame. | LOCK | 🚶 medium | KEEP |
| `laser-smoothness.spec.ts` | `@feature` | Local laser beam stays attached to ship pose during fire+rotation. Now covered by the integration-smoke `drone-laser-smoothness` for the drone case; this is the local-ship case. | LOCK | 🚶 medium | KEEP |
| `living-world.spec.ts` | `@feature` | Hunter bots converge on the player's sector. Outcome-gated (polls `/dev/population` + HUD testids), never perf/tick-gated. | LOCK | 🚶 medium | KEEP |
| `network-feel-combat.spec.ts` | `@feature` | Sustained drone combat stays within bounded drift. | LOCK | 🚶 medium | KEEP |
| `prediction-diagnostics.spec.ts` | `@feature` | 3 tests: no-input drift near-zero on localhost; two-client drift within tolerance; local prediction updates between server snapshots. Source of the budget ceilings now in `netHealthBudget.ts` (`maxDriftUnits < 1.0u` clean; `rollingCorrRate < 0.2` clean). | LOCK | 🚶 medium | KEEP |
| `robustness.spec.ts` | `@feature` | 10 tests covering snapshot cadence, jitter, ticksAhead bounds, rotate-only corrections, no-oscillating-corrections, two-client thrust, asteroid collision corrections, post-collision stability, p2p correction rate, p2p ship overlap, two-client asteroid-position agreement. The exhaustive multi-client correctness suite. | LOCK | 🐢 slow (27 `waitForTimeout`) | KEEP — Phase 2c predicate-cleanup target |
| `rotate-jitter.spec.ts` | `@feature` | Rotate-only diagnostic — hold `D` for 3 s, dump stats + correction log. | LOCK | 🚶 medium | KEEP |
| `ship-roster-panel.spec.ts` | `@feature` | Fresh user → galaxy-map-screen panel mounts with `data-roster-count="0"`; after spawn, drawer Galaxy tab panel shows the new ship. | LOCK | 🚶 medium | KEEP |
| `swarm-bandwidth.spec.ts` | `@feature` | Phase 5e bandwidth acceptance — 4 clients × 30 s in swarm-soak, per-client mean < 60 KB/s. | LOCK | 🐢 slow (30 s sample) | KEEP |
| `swarm-jitter.spec.ts` | `@feature` | Drone movement per-frame delta < 2u (no stutter). | LOCK | 🚶 medium | KEEP |
| `swarm-sleep.spec.ts` | `@feature` | Phase 5e sleep handshake — single stationary asteroid → ~1 packet/sec after 12-tick hysteresis. | LOCK | 🚶 medium | KEEP |
| `swarm-stationary-stability.spec.ts` | `@feature` | Stationary asteroids: rendered position stays within 0.5u over 3 s. | LOCK | 🚶 medium | KEEP |
| `swarm-tidi.spec.ts` | `@feature` | Phase 6c full TiDi+LoadShedder acceptance: clockRate < 0.99, ramp to floor ≤0.71, LoadShedder fires, ship remains controllable. 4-stage gate. | LOCK | 🐢 slow (60 s) | KEEP |
| `sync-diagnostics.spec.ts` | `@feature` | Sync diagnostics: idle → W-thrust → release. | LOCK | 🚶 medium | KEEP |
| `sync-health.spec.ts` | `@feature` | W-thrust correction rate < 15% after 3 s; idle correction rate near-zero. | LOCK | 🚶 medium | KEEP |
| `tidi-overlay.spec.ts` | `@feature` | Phase 6b TiDi overlay — `data-sector-alert` = "Temporal Anomaly", clockRate < 0.99 within 30 s. | LOCK | 🐢 slow (75 s timeout) | KEEP |
| `wreck-render-probe.spec.ts` | `@feature` | 4 tests on wreck-sprite lifecycle at the `WorkerRendererClient ↔ worker ↔ PixiRenderer` boundary. Mirror of `damage-number-lifetime.spec.ts` for wrecks. Note: filename says "probe" but content is real assertions. | LOCK | 🚶 medium | KEEP |
| `renderer-worker-probe.spec.ts` | `@feature` | Renderer worker boot + mirror + feedback round-trip lock. Same caveat — "probe" filename, real assertions. | LOCK | 🚶 medium | KEEP |
| `netcode-health.spec.ts` | `@gate` | The Phase-1 deliverable — baseline-vs-HEAD netcode-health budget assertion. `skip`s when `NETGATE_ARMS` is unset (driven by `pnpm e2e:netgate` only). | LOCK (relative) | n/a (driven) | KEEP |
| `drawer-cdp-starvation-probe.spec.ts` | `@diag` | CDP roundtrip under steady-state Pixi load — captures `cdp-perf.json`. | CAPTURE | 🐢 slow | MOVE → `tests/diag/` |
| `drawer-keepmounted-probe.spec.ts` | `@diag` | DOM contract probe — `drawer-panel-galaxy` is in DOM before any drawer click. Asserts a single DOM presence but is part of the drawer-perf investigation captures. | CAPTURE-ish | 🚶 medium | MOVE → `tests/diag/` |
| `drawer-lag-trace.spec.ts` | `@diag` | Drawer-toggle click → galaxy-tab-show-map visible — explicitly written for the drawer perf paradigm investigation (LESSONS.md 2026-05-13). Now a capture probe; the actual perf budget lives in the SX-hoist rules in `AdvancedDrawer.tsx`. | CAPTURE | 🐢 slow | MOVE → `tests/diag/` |
| `modal-close-diagnostic.spec.ts` | `@diag` | Modal close diagnostic — DOM dump at each step. Pure data capture. | CAPTURE | 🚶 medium | MOVE → `tests/diag/` |
| `offscreen-spike-probe.spec.ts` | `@diag` | Boot + pan + zoom + tap — captures via Playwright. Part of the OffscreenCanvas migration investigation. | CAPTURE | 🐢 slow (7 `waitForTimeout`) | MOVE → `tests/diag/` |
| `warp-spool-perf-capture.spec.ts` | `@diag` | Warp-spool perf capture (F2 of warp-spool perf followup). Explicit "data only, not a regression lock" in its own test title. | CAPTURE | 🐢 slow (90 s timeout) | MOVE → `tests/diag/` |

## Verdicts roll-up

| Bucket | Count | Verdict |
|---|---:|---|
| `@smoke` | 14 | KEEP all. Default CI step 1; smoke-first fail-fast. |
| `@feature` | 30 | KEEP all. Default CI step 2. Two specs (`combat`, `robustness`) carry most of the `waitForTimeout` debt — Phase 2c target. Two drawer-* specs flagged for *consolidation* (one combined `@feature` covering open/close + roster-card flow), but consolidation is its own commit, not part of the tagging commit. |
| `@gate` | 1 | KEEP. Driven by `pnpm e2e:netgate`; standalone `pnpm e2e:gate` runs a skipped no-op (expected). |
| `@diag` | 6 | MOVE to `tests/diag/`, exclude from `testDir`. Manually runnable for investigations; never in CI. |
| Total | 51 | |

## Phase 2 acts on this doc — implementation order

1. **`refactor(e2e): tag specs into smoke/feature/gate tiers (plan: e2e-rebuild)`**
   - Edit `playwright.config.ts`: add `projects` array with `smoke` / `feature` / `gate` entries using `testMatch` lists drawn from the table above. Zero in-spec edits — the tier lives in the config.
   - Add `pnpm e2e:smoke` / `pnpm e2e:gate` scripts; rewrite `pnpm e2e` to `playwright test --project=smoke --project=feature` (gate is invoked separately).
   - Sanity: `pnpm e2e:smoke` runs the 14 listed specs and nothing else; `pnpm e2e` runs 14+30; `pnpm e2e:gate` runs only `netcode-health.spec.ts` (which skips).

2. **`chore(e2e): move diagnostic captures to tests/diag, drop from CI (plan: e2e-rebuild)`**
   - `git mv` the 6 `@diag` specs into `tests/diag/`.
   - Either update `playwright.config.ts:testDir` to remain `'./tests/e2e'` (already correct — the move alone drops them) OR add explicit `testIgnore: ['**/tests/diag/**']` for clarity.
   - Update the 6 specs' module docstrings to mention they're manually runnable from `tests/diag/`.
   - Cleans up the 29 "unused eslint-disable" lint warnings concentrated in those files.

3. **`refactor(e2e): state predicates over fixed waits (plan: e2e-rebuild)`**
   - Replace `waitForTimeout` settles with `waitForFunction` predicates across the kept `@smoke` and `@feature` specs. Skip intentional pacing (rare — almost always there is a better predicate).
   - Scope-bound: the 196 `waitForTimeout` occurrences live across 36 files; the cleanup is per-spec, test-first (each affected test must still pass after the rewrite).
   - The highest-debt files are `combat.spec.ts` (36) and `robustness.spec.ts` (27) — those alone are 32% of the total. Smaller batches commit per-spec or per-group.

4. **`chore(ci): raise globalTimeout + suite cap, add bench:check (plan: e2e-rebuild)`**
   - `playwright.config.ts:36`: `globalTimeout` 6 min → ~25 min (hostile M4 — 6 min would abort the whole suite first on a slow runner).
   - `.github/workflows/ci.yml`: `timeout-minutes: 15` → `25`; add `bench:check` step (`pnpm run bench` against committed `benchmarks/baseline.json` — already exists, just unwired from CI).
   - Optionally re-sequence the e2e steps in CI as `pnpm e2e:smoke` → `pnpm e2e` (smoke-first fail-fast). The default `pnpm e2e` already runs smoke first via project order, so this is mostly cosmetic CI clarity.
   - **DO NOT** add `pnpm e2e:netgate` to CI in this commit. The gate creates worktrees and is multi-minute; wiring it into CI is Phase 5 work after the gate's CI cost is measured and the worker count / lockfile sync model are settled.

## Open questions, deliberately deferred

- **Should `feel-test-lockstep` + `feel-tuning` be reaped?** Their per-frame canary role is now in `tests/unit/swarmInterpolation.smoothness.test.ts` (deterministic, ~1 s) and `netcode-health.spec.ts` (relative, machine-insensitive). They survive here as integration smokes that cross-validate the live server+client. If they ever flake on the CI runner, the answer is to reap them, not widen the bound — the load-bearing canary is elsewhere.
- **Should the consolidated drawer spec be written in Phase 2 or Phase 3?** Plan said "the 6 drawer-* collapse to one `@feature`" but only 2 of the drawer-* specs are real-flow locks (`drawer-galaxy-overview-spawn`, `drawer-galaxy-map-open-close`); the other 4 are `@diag` and get moved out. Consolidating those 2 is its own refactor — not part of the Phase 2 tagging commit.
- **Where do new tests file themselves?** New specs default to `@feature`. Promoting to `@smoke` requires (a) the spec stays under 30 s, (b) it locks a critical-path failure mode (boot/join/spawn/basic combat/ship switch/persistence/mobile/probe-page), (c) it uses state predicates not fixed waits. Demoting to `@diag` requires the spec to be capture-only — `@diag` is a quarantine for "useful for debugging, useless as a regression signal," and a spec that asserts behaviour should never be `@diag`.

## Current health (2026-05-20 baseline `pnpm e2e:smoke` run on `feat/e2e-rebuild @ 937e608`)

First post-Phase-2 smoke run. Results: **31 passed / 19 failed of 50 (15 min wall-clock).** None of the failures are recent regressions — every one points at a stale spec that hasn't run since an old UI refactor. The cluster is informative; per-spec repair is queued for follow-up sessions (each broken spec gets its own small commit: find the new UI signal, replace the old locator, re-run, lock the fix).

### Stale-at-HEAD smoke specs needing repair (19 tests)

| Spec | Tests failing | Root cause (likely) |
|---|---:|---|
| `sector-alpha.spec.ts` | 11 / 11 (ALL) | `joinSector` helper clicks `getByRole('button', { name: /enter sector alpha/i })` — the string "Enter Sector Alpha" does not exist in any `src/` file; the post-auth join flow was refactored to galaxy-map-spawn. Every test fails at its first action. |
| `ship-selection.spec.ts` | 4 / 4 (ALL) | Ship-picker UI flow changed; the spec's locators no longer match. |
| `scenarios/combat-lifecycle.spec.ts` | 2 / 5 | `:108` (full lifecycle respawn) and `:155` (shooter sees hull decrease) — likely the same post-auth flow issue or a shared helper assumption. The first 3 tests pass. |
| `spawn-select-flow.spec.ts` | 1 / 2 | `:44` (galaxy-sector variant) fails; `:19` (engineering-sector variant) passes. Galaxy-sector click flow has diverged. |
| `weapon-switching.spec.ts` | 1 / 6 | `:114` (laser ghost sprite cleanup) — race between weapon-switch and the brief tap-fire. Plausibly a real flake rather than a stale-locator issue (see Phase 2c notes in the plan-status memory). |
| `happy-path-ui-switch.spec.ts` | 1 / 1 (ALL) | `:97` (drawer → Galaxy tab → roster card → Spawn) — also likely the new spawn flow. |
| **TOTAL** | **19** | |

### Stable-at-HEAD (31 tests)

`boot.spec.ts` (1), `damage-number-lifetime.spec.ts` (3), `happy-path-switch-ship.spec.ts` (1), `join-warp-screen.spec.ts` (3), `layout-slots.spec.ts` (1), `mobile-joystick-ship-swap.spec.ts` (1), `persistence-kill.spec.ts` (1), `scenarios/combat-lifecycle.spec.ts` (3), `shield-hud.spec.ts` (1), `spawn-select-flow.spec.ts` (1), `weapon-switching.spec.ts` (5).

### Repair playbook (when picking off a broken spec)

1. Open the spec, find the first action that fails (usually a `getByRole`/`getByText`/`waitForSelector` for a UI element).
2. Locate the new UI signal in `src/client/` (grep for the surface name — e.g. "ship picker" / "galaxy map" — to find the current component).
3. Update the spec's locator OR replace the click with the new flow (often the spec needs to traverse drawer → galaxy tab → sector card instead of clicking a top-level "Enter X" button).
4. Run the spec in isolation: `pnpm e2e:smoke tests/e2e/<file>.spec.ts --reporter=line --grep "specific test"`.
5. Commit per spec: `fix(e2e): repair stale <surface> spec — <reason> (plan: e2e-rebuild)`.

The clustering means most fixes are mechanically similar — once `sector-alpha.spec.ts`'s `joinSector` helper is updated to the new flow, the same pattern likely repairs `ship-selection` + `happy-path-ui-switch` + `spawn-select-flow:44`.

### What we do NOT change for this finding

- **Do not delete the broken specs.** They lock real surfaces (two-client isolation, identity persistence, physics-worker tick continuity, etc.). Deletion would lose coverage; repair preserves it.
- **Do not change the tier of broken specs.** A failing smoke spec is exactly the signal the smoke tier exists to surface; demoting them to `@feature` (where failures are less visible) defeats the purpose.
- **Do not lower the smoke pass-rate bar in CI yet.** Phase 5 wires the smoke run into CI; before that wire-up, repair the broken specs OR explicitly skip them with a documented `test.skip(STALE)` annotation. CI red on a stale spec is a *correct* signal that the repair queue is non-empty.
