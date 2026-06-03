# E2E framework — tier taxonomy + per-spec triage

**Status:** Phase 0b of the e2e-rebuild plan (`C:\Users\alecv\.claude\plans\i-want-you-to-lively-tulip.md`). Phase 2 acts on this doc — tagging specs into Playwright projects, moving `@diag` specs out of CI, replacing `waitForTimeout` settles with state predicates, raising the suite timeout.

> **⚠️ The per-spec triage table + verdict roll-up below are PARTIALLY STALE** (they predate the measurement-spec proliferation and the weapons/energy work). The authoritative current state is the **Determinism refactor** section immediately below; the full table refresh is the final commit of `docs/refactors/test-coverage-audit.md`.

## Determinism refactor (2026-06-03, `docs/refactors/test-coverage-audit.md`)

Executing on branch `claude/test-coverage-refactor-exec`. A read-only audit (one agent per delete/relocate/merge candidate, adversarially verifying each "superseded by X" claim) preceded every change. It caught **4 plan errors** where literal execution would have deleted unique coverage — those specs were preserved (see below).

**Phase 1 — DONE.** Relocate fixed-window measurement specs → `tests/perf/` (run via `pnpm e2e:perf`, never in the per-PR `pnpm e2e`), delete one-off investigation captures.

- **Relocated to `tests/perf/` (13):** `heap-growth-gate`, `combat-heap-growth` (keeps slope<0.4 / rafGap<10 / maxStall<150 budgets), `combat-allocation-profile`, `combat-allocation-profile-hostile`, `heap-snapshot-diff`(+`-worker-off`,`-mobile-emu`), `swarm-bandwidth` (keeps 60/90 KB/s budgets), `worker-ab-perf`(+`-mobile-emu`), `diag-mode-side-effect`, `mobile-perf-probe4`, **`webrtc-vs-ws-recv-gap-comparison`** (audit-corrected from DELETE→RELOCATE — carries the WebRTC exit-gate: DC cuts recv_gap_long ≥70% under bursts, lives nowhere else). Imports needed zero rewrites (all `@playwright/test`-only or `../../scripts/...`, which resolves identically from `tests/perf/`).
- **Deleted (8 one-off captures):** `autocapture-observer-effect`, `combat-heap-growth-fx-bisect`, `network-buffer-and-throttle-repro`, `spiral-in-pack-density`, `spiral-joystick-flicker`, `webrtc-mobile-emulation-stutter`, `webrtc-mobile-emulation-control`, `maxdrift-investigation`. (Stale code comments in `fxKillSwitches.ts` / `joystickToInput.ts` / `ColyseusClient.ts` that named deleted specs were repointed to the surviving locks.)
- **Audit coverage-corrections — KEPT despite the plan saying delete/merge** (each holds an assertion that lives NOWHERE else): `spiral-disconnect-reconnect` (post-reconnect ticksAhead/corr bound — the 2026-05-20 unplayable `9hj9sl` lock), `prediction-diagnostics` (T3 sub-snapshot prediction-running lock; doc's own line 69 calls it the *source* of the netgate ceilings), `laser-smoothness` (local-beam origin-attachment ≠ the drone leak-guard; zero overlap). Their surgical trim/fold is deferred to Phase 3.
- **`energy-bar.spec.ts`** was orphaned (in no project's `testMatch`, so never ran) — registered into `FEATURE_SPECS`.

**Counts after Phase 1:** `tests/e2e/` **55** spec files (54 `@smoke`+`@feature` + 1 `@gate`); `tests/perf/` **14**. `FEATURE_SPECS` 59→39.

**Phase 2a — DONE.** Delete specs whose coverage is genuinely owned elsewhere.

- **Deleted (5):** `happy-path-ui-switch` (a `test.fixme` — zero live coverage; the room-swap-render path is covered by `happy-path-switch-ship`. NOTE: the real-UI Spawn-button-click-to-swap leg is now formally uncovered — it was already inert via fixme), `sync-diagnostics` + `rotate-jitter` + `network-feel-combat` (drift/correction-rate owned by the netcode-health gate; `rotate-jitter`'s rotate-only angle-correction also by `robustness.spec.ts` #4; `network-feel-combat`'s unique stuck-offset anomaly by `tests/scenarios/welfordPostGapPollution.test.ts`), `held-fire-continuous-damage` (a `test.skip`; cadence locked by the `damageNumberEvents`/`LocalBeam`/`WeaponCatalogue` unit canaries).
- **Audit-corrected — KEPT despite the plan saying delete** (trim deferred to Phase 3): `feel-test-lockstep` (sole live >12-drone client+server+wire smoke; the repo's own table below + `src/client/CLAUDE.md` call it KEEP), `feel-tuning` (Test 2 = slow-down displacement lock, lives nowhere else), `sync-health` (W-thrust continuous-3s corrRate<0.15 lock, nowhere else).

**Phase 2b — DONE (merges).** `tidi-overlay`→`swarm-tidi` (pure delete — swarm-tidi Stage 1 already asserts the same `data-sector-alert`+clockRate condition with a tighter budget; nothing to fold). `swarm-stationary-stability`→`swarm-jitter` (added as a 2nd test() — the kind=0 asteroid cumulative-drift<0.5u metric is distinct from the kind=1 drone per-frame-delta check, kept as its own test, shared sampling harness deduped). drawer pair (`drawer-galaxy-map-open-close`+`drawer-galaxy-overview-spawn`)→new `drawer-galaxy.spec.ts` (two test()s: open→X-close + double-mount audit + per-step lag budget at 25 s; roster-card→detail-modal real-click at 120 s — the click→modal path lives only here, NOT in `ship-roster-panel`).

**Phase 3 — combat split + drone-destruction rewrite (the load-bearing correctness work).** Replaced the 12-test `combat.spec.ts` (which joined the random `?room=sector` and had 5 spray-and-pray loops with conditional assertions that silently passed on a miss) with **7 deterministic specs under `tests/e2e/combat/`**: `beam-appears`, `hull-decreases-on-hit`, `victim-sees-death`, `remote-laser-targetid`, `remote-laser-range-truncation`, `remote-beam-visible` (tests 7+10), `swarm-hit-detected`. The proven geometry: shooter `?shipKind=interceptor` at (0,0)/`initialAngle:0` fires a hitscan beam straight up +y (range 250u); victim/target parked at (0,200) with `initialShield:0` — a held beam is a guaranteed, repeatable hit. `drone-destruction.spec.ts` rewritten onto the new **`combat-drone-test`** server room (one peaceful, hull-exposed heavy parked in the beam line) — hard assert "drone count drops by exactly 1" (was a weak `<=` with an "RNG may miss" disclaimer). Harness: `TestClientOpts` gained `initialAngle`/`shipKind` + the combat data-getters (early pull of the Phase-5 helper consolidation). **Determinism proof:** the first `--repeat-each=3` pass caught 3 flakes (all the same death-window race — a target that died mid-test narrowed the observation window / raced the post-death state); fixed by making observation-victims survive (high `initialHull`), catching death atomically (single combined predicate), and using a 540-HP target drone. Re-verified green across repeats. Also trimmed **`feel-tuning`** to its unique slow-down-displacement lock (dropped the superseded `?room=sector` correction-halflife test, which trivial-passed when no corrections logged).

**`respawn-cascade-input-routing` — DONE (group A complete).** Rewritten off the live `galaxy-sol-prime` + `diag=1` join onto the new engineering `cascade-test` room (4 drones) joined with `startHostile=1` to reproduce the bot-pressure the bug needed, plus a survivable `initialHull` so the player never dies (the damage/aggro state-churn is present, the thrust-moves-the-ship assertion stays deterministic). Drives the DEV-gated `__eqxTriggerRespawnCascade()` hook twice; asserts thrust moves the ship after each cycle. 3/3 green across repeats.

> Still pending in Phase 3 (deferred, NO coverage loss — the specs stay intact): `sync-health` idle-half trim; `prediction-diagnostics` T3-fold into `prediction-idle-bounded`. Phases 4 (`waitForTimeout`→predicate sweep on retained `@feature` specs) and 5 (route remaining specs through `launchTestClient`, `tests/perf/` intake doc) are not yet started.

> The per-spec triage table below still lists several now-deleted specs (`sync-diagnostics`, `rotate-jitter`, `network-feel-combat`, `happy-path-ui-switch`) as KEEP — those rows are superseded by this section pending the full table refresh (final refactor commit).

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
| `@mobile-perf` | Local-only mobile heap + DOM + RAF jitter gate. Joins `test-sector-fast` (10× physics) against either a real Android device / AVD via `playwright._android` or a CDP-throttled (`Emulation.setCPUThrottlingRate` ×4) desktop Chromium fallback. Enforces an absolute budget on `jsHeapUsedMb`, `jsHeapGrowthMb`, `documentCount`, `jsEventListeners`, `longtaskCount30s` via the `{ margin, eps, ceil }` AND-gate pattern mirrored from `netHealthBudget.ts`. `rafP50Ms`/`rafP99Ms`/`rafGapCount30s` are tracked as PRINT-ONLY (same disqualifier as `snapshotJitterMs`: throttle/thermal dominated). | `pnpm e2e:mobile-perf` (driver: `playwright.mobile-perf.config.ts`). Per-test cap 60 s. Lives under `tests/mobile-perf/`. Excluded from `pnpm e2e` by base config's `testDir: './tests/e2e'`. NOT in CI (no `adb` / Android emulator on `ubuntu-latest`). Mode via env `MOBILE_PERF_MODE`: `force-fallback` (default in remote container), `force-device` (developer with USB device), `auto`. |

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
| `warp-engage-cancel.spec.ts` | `@feature` | Phase 3b — full warp/transit state-machine roundtrip E2E: engage_transit wire → SPOOLING overlay (`data-testid="hyperspace-overlay"` + `data-transit-state="SPOOLING"`) → cancel_transit wire → DOCKED (overlay unmounts). The wire roundtrip lock the plan called the biggest Phase-3b gap; commit/arrive side covered by integration tests (warpBroadcasts / TransitOrchestrator / transitArrivalDrift / WarpScreen.transit / rearmJoinReadiness). | LOCK | 🚶 medium (~20 s; dominated by warp curtain wait, not game-time) | KEEP |
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
| `@feature` | 31 | KEEP all. Default CI step 2. Two specs (`combat`, `robustness`) carry most of the `waitForTimeout` debt — Phase 2c target. Two drawer-* specs flagged for *consolidation* (one combined `@feature` covering open/close + roster-card flow), but consolidation is its own commit, not part of the tagging commit. Count bumped 30→31 with `warp-engage-cancel.spec.ts` (Phase 3b, 2026-05-20). |
| `@gate` | 1 | KEEP. Driven by `pnpm e2e:netgate`; standalone `pnpm e2e:gate` runs a skipped no-op (expected). |
| `@diag` | 6 | MOVE to `tests/diag/`, exclude from `testDir`. Manually runnable for investigations; never in CI. |
| Total | 52 | |

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

## Bespoke gameplay triggers — catalogue + design rules

**The principle:** E2E tests must be **highly controlled and tightly scoped**. Target wall-clock per test is **1-2 seconds** wherever game logic allows. When a test needs longer, almost always the right move is to **add a bespoke server-side gameplay trigger that bypasses the game-time wait**, NOT to expand the timeout. Bumping the budget hides the real signal, invites flakes, and silently breaks again on the next gameplay-tuning PR.

### Triage flow (when a test needs > 30 s default)

1. *What gameplay state am I waiting for?*
2. **Infrastructural cost** (page navigation, browser cold-boot, Colyseus join + first snapshot, Vite cold-compile) — a budget bump is reasonable. Not under test control.
3. **Game-time cost** (TTK, projectile travel, shield regen, warp spool, respawn delay, ghost TTL, snapshot cadence convergence) — **find or add a bespoke trigger**. The new primitive pays for itself within 2-3 tests.

### Catalogue

| Primitive | Purpose | API |
|---|---|---|
| `initialHull: number` | Override spawn HP. `1` = one-tick-kill. (Use `10` if the test polls `data-hull-pct === '0'` to confirm death — `1` rounds to 0 % against `maxHealth`.) | URL `?initialHull=N` or `launchTestClient({ initialHull: N })`. testMode-gated server side. |
| `initialShield: number` | Override spawn shield. `0` = first beam hit lands hull immediately, no shield buffer to absorb. | URL `?initialShield=N` or `launchTestClient({ initialShield: N })`. testMode-gated. |
| `testTimeScale: number` (room option) | Multiplies physics-tick dt at the worker level. `test-sector-fast` ticks 10×. Ghost TTL (500 ms) → 50 ms wall-clock; projectile lifetime (4 s) → 400 ms; warp spool (30 s) → 3 s; regen cycles likewise. Server-side `state.clockRate` stays unmultiplied so audio + TiDi UI don't show fake anomalies. | Set on the room definition in `src/server/index.ts`. Currently `test-sector-fast = 10×`. Use `launchTestClient({ room: 'test-sector-fast' })`. |
| `testId: string` + `filterBy(['testId'])` | Per-test room isolation via Colyseus matchmaker. Each unique testId routes to its own room instance. | `launchTestClient` defaults to `randomUUID()` per call. Multi-client tests mint one testId at the test level and pass to every client. |
| `injectLeak: number` | Mobile-perf gate regression-lock — retains `N` bytes per RAF tick on `window.__testLeak` so the `jsHeapGrowthMb` budget metric can be exercised end-to-end. DEV-build only (Vite tree-shakes the hook from prod via `import.meta.env.DEV`); the URL param alone does nothing in a production deploy. Used by `tests/mobile-perf/heap-budget-injected-leak.spec.ts`. | URL `?injectLeak=N` (e.g. `102400` = 100 KB/tick) or `launchTestClient({ injectLeak: N })`. Server-side accepts and ignores — the value is consumed client-side by `src/client/debug/testLeakHook.ts`. |

### Adding a new primitive

When 3+ tests would benefit from the same skip, it's worth adding a new server-side trigger. Pattern:

1. Define the JoinOption (zod schema, testMode-gated) in `SectorRoom.JoinOptionsSchema`.
2. Apply it in `onJoin` (after kind-default initialisation, before persistence write).
3. Wire URL → joinOption in `App.tsx`'s URL-param pass-through block (`if (urlParams.has('myFlag')) extraJoinOptions['myFlag'] = ...`).
4. Surface in `TestClientOpts` in `tests/e2e/helpers/gameScenario.ts`.
5. Document here in this catalogue.

### Backlog (don't add until needed)

- `initialDeath: true` — spawn the ship already destroyed. Test the respawn UX without the kill setup.
- `instantWarpSpool: true` — bypass the 30 s spool. Test warp completion + arrival binding without 30 s of waiting.
- `bypassJoinGrace: true` — skip the 5 s `JOIN_BROADCAST_GRACE_TICKS` snapshot window. Useful for post-warm-up assertions.
- `pinnedDronePoses: Array<{id, x, y}>` — deterministic drone placement instead of default scatter.
- `weaponCooldownTicks: 1` — per-tick fire mode. Lets ghost / projectile tests fire many shots in sub-second wall-clock.

### Anti-patterns (reject in code review)

- `test.setTimeout(N_MUCH_LARGER)` without a corresponding game-time trigger added.
- `await page.waitForTimeout(N)` to pace past a game-time wait. Use `waitForFunction(state predicate)` with the same N as a *deadline*, while triggering the state through a bespoke flag.
- Hardcoded `expect(duration).toBeLessThan(N)` that assumes pre-tuning TTK / cooldown.
- Tests that only fail when a recent gameplay-tuning PR landed — that's a test-design defect, fix at the source.

### Proof the philosophy pays off (2026-05-20 vanity stat)

Smoke suite went from 31 pass / 19 fail / ~15 min → **41 pass / 3 fail / 6 skipped / 8.3 min** — same 50 tests, sequentially executed on the same box. Per-test repair work mostly meant "add the right primitive" (the `initialHull/initialShield` server-side override, the `testTimeScale` room option, the `filterBy(['testId'])` per-test rooms) — not "bump the timeout."

## Project-local skills (Phase 4c, 2026-05-20)

Two slash commands live in `.claude/skills/` so any dev who clones the repo gets them automatically (Claude Code auto-discovers `.claude/skills/<name>/SKILL.md`):

| Skill | When to use | What it does |
|---|---|---|
| `/netgate` | After live-loop-touching changes (anything under `src/client/net/`, `src/core/prediction/`, `src/core/physics/`, render loop, snapshot decode/interpolate, mount aim, `SectorRoom` tick/snapshot). | Runs `pnpm e2e:netgate [<baselineRef> <headRef>]`, parses the verdict stanza (baseline + HEAD stat blocks + REGRESSION lines + PASS=...), reports pass/fail with the offending metric + magnitude, suggests `git bisect run pnpm e2e:netgate` on RED. The front door to Phase 1. |
| `/e2e-triage <spec.ts>` | When a `@smoke` or `@feature` spec is failing and you want to know if it's locator drift, timing, or a real regression. | Re-runs the spec in isolation, classifies the failure (LOCATOR_DRIFT / TIMING_RACE / REAL_REGRESSION), proposes a deterministic fix. **For TIMING_RACE the fix MUST be a bespoke trigger, never a timeout bump.** Refuses `@gate` triage — routes to `/netgate` instead so a margin-loosening "fix" is impossible via this skill. |

Phase 4a (Playwright `init-agents --loop=claude` planner / generator / healer) needs Playwright v1.56+; this repo is on 1.49.0. Deferred until the upgrade lands as a separate dependency story — agents are breadth-only per the plan, gates AI-fenced.
