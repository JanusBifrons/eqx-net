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

**Phase 3 trims — DONE.** `sync-health`: dropped the idle test (its floor is locked by `prediction-idle-bounded`), kept the unique W-thrust continuous-hold corrRate<0.15 lock. `prediction-diagnostics`: **discovered it was DEAD** — it joined via a stale `getByRole('button', {name:/enter sector alpha/i})` flow removed months ago, so all 3 tests failed at the join and it provided zero live coverage. Deleted it; folded a *deterministic* version of its unique T3 (sub-snapshot prediction-running, `uniquePos>5` while coasting) into `prediction-idle-bounded` on the feel-test-25 engineering room (verified green). T1 drift-ceilings are covered by the idle floor + netgate; T2 two-client agreement by `robustness`'s p2p cases.

> **Host-load caveat:** `sync-health`'s W-thrust (corrRate<0.15) and `prediction-idle-bounded`'s idle (ZERO corrections) are tight correction-rate timing locks — they failed on the dev box during this session's ~25 min of continuous E2E (the box was saturated). Their test bodies are UNCHANGED by this refactor, so per the repo's "timing-E2E is a host-load sensor — baseline in same env" rule these are host-load artifacts, not regressions; the netcode-health gate is their machine-insensitive signal. Re-confirm on a quiet host.

> Phases 4 (`waitForTimeout`→predicate sweep on retained `@feature` specs — the highest debt is `robustness.spec.ts` at 27; the combat split + respawn-cascade were already authored with state predicates) and 5 (route remaining specs through `launchTestClient`, `tests/perf/` intake doc, parallelism note) are not yet started. Phase 4 will also surface more stale-locator specs like `prediction-diagnostics` (e.g. `sector-alpha`/`ship-selection` per the table below) that need the same engineering-room repair.

> The per-spec triage table below still lists several now-deleted specs (`sync-diagnostics`, `rotate-jitter`, `network-feel-combat`, `happy-path-ui-switch`) as KEEP — those rows are superseded by this section pending the full table refresh (final refactor commit).

## Join helpers wait for play; the drawer ticker pause is an explicit flag (2026-11-08)

- **`launchTestClient` / `launchGalaxyTestClient` return only once the client is IN PLAY** (`waitForInPlay`: the loading curtain `warp-screen[data-warp-visible="0"]` has lifted). A ship that exists behind the curtain ignores input and is not targetable yet. Commit 23b15fb0 (#310) made 126 `waitForFunction` deadlines real, and a spec that acted on `ship-count > 0` then missed its 2 s deadline by the ~2.4 s curtain (`beam-appears`: 6/6 pass before that commit, 6/6 fail after). Pass `waitForInPlay: false` only in a spec that watches the curtain itself (`join-art-ready`, `loading-catchup`). Specs that join with their own `page.goto` call `waitForInPlay(page)` themselves.
- **The Pixi ticker pauses behind a drawer / the galaxy overview only when the E2E harness asks** (`src/client/app/automationTickerPause.ts`): `localStorage.eqxE2ePause === '1'` or `?e2ePause=1`. `tests/e2e/global-setup.ts` writes `e2e-storage-state.json` (auth + the flag) and only the `smoke` / `feature` / `gate` projects use it, so drawer-heavy specs keep the CDP-starvation workaround (LESSONS 2026-05-13 §6). The showcase recorder (`chromium.launch`, no storage state) and the perf configs (auth-only state) run the game live behind menus. It used to key on `navigator.webdriver`, which froze the game in every showcase take with a menu open.
## Polling `/dev/events` for a rare event (2026-11-12)

The ring is shared by every room in the server, galaxy included. At its default 500 entries it held only ~2-3 s on a loaded host, so a spec polling the newest 500 for a lone event (a missile's expiry) could miss it. The Playwright server runs with `EQX_DEV_EVENTS_MAX=5000`, and `GET /dev/events?tag=<tag>&limit=N` returns the newest N entries with that tag from the whole ring. Poll for a single tag with `?tag=`, and start polling BEFORE any slow step that precedes the event (closing a context can take seconds). See `missile-frigate-homing.spec.ts` `fetchEvents`.

## CI scope — @smoke only, sharded + reruns (2026-06-03)

**`.github/workflows/ci.yml` gates PR merges on the `@smoke` tier ONLY**, not `@smoke`+`@feature`. Two jobs:

- **`verify`** (single job): `typecheck` + `lint` + unit/integration `test` + `build`. Fast, never flaky.
- **`e2e-smoke`** (matrix): the `@smoke` tier, split across a **shard matrix** (`--shard=i/N`) so N independent GitHub-Actions jobs run in parallel — each with its OWN `dev:server:nowatch` + vite, so the `workers:1` shared-server contention (which blocks *in-process* parallelism — see `playwright.config.ts`) does not apply *across jobs*. Per-test rooms (`filterBy(['testId'])`) keep shards isolated. Runs with **`PLAYWRIGHT_RETRIES=2`** so a transient two-client / timing hiccup retries instead of failing the PR (local dev stays 0 retries per policy #2 — this is the documented "known-flaky environment" override).

**Why @feature is excluded from the merge gate.** The full-suite run on 2026-06-03 confirmed `@smoke` is green (the lone flake, `sector-alpha:243`'s two-client room-sharing race, is absorbed by reruns), while `@feature` carries **pre-existing** flaky/failing locks that predate this refactor and are a *separate* de-flake project:
- **Two-client room-sharing races** — specs that put two browser contexts in one room via an undefined `testId` (a Colyseus matchmaking race) intermittently land in separate rooms (`robustness`'s p2p tests, `sector-alpha:243`).
- **Stale locators** — `robustness`'s 4 two-client tests clicked the removed "Enter Sector Alpha" button (**repaired 2026-06-03** to the `?room=sector` auto-join; `sector-alpha`/`ship-selection` were already repaired to the Join-the-fight → galaxy-map flow).
- **Host-load-sensitive timing** — tight correction-rate locks (`sync-health` W-thrust, `prediction-idle-bounded` idle, `robustness:281` post-collision, `ramming-probe-armpit`) that fail on a loaded runner; the netcode-health gate is their machine-insensitive replacement.

Gating PRs on those would make CI red on environment noise. `@feature` stays runnable via `pnpm e2e` (full) / `pnpm e2e:feature` for thorough local + manual checks, and specs are incrementally de-flaked (deterministic spawns + shared `testId` + state predicates) and **promoted back into the CI smoke gate** as they harden — the deterministic combat split (`tests/e2e/combat/*`) is the first promotion candidate once its behaviour is confirmed on the CI ubuntu runner.

**Advisory runs (2026-11-08, not required checks).** Two backstops so non-gating tiers can't rot unseen:
- **`e2e-feature-affected`** (ci.yml, per PR): the `@feature` specs the PR's paths map to (`tests/e2e/featureTriggers.mjs`), 3 shards.
- **`.github/workflows/e2e-feature-weekly.yml`** (Mondays 04:17 UTC + `workflow_dispatch`): the FULL `@feature` tier, 6 shards, blob reports merged into one HTML artifact + a pass/flaky/fail table in the run summary. Not in `auto-retry.yml`, so a red there is read as-is.
- **`gc-tests`** (ci.yml, per PR) runs `pnpm test:gc` (the heap-delta suite) — not E2E, but the same "ran only locally, rotted" story.

Making any of these required needs the user's sign-off.

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

### Test at the level the bug lives — the mock-seam anti-pattern (Invariant #13)

The tier choice above is "how deterministic / how fast"; this is the orthogonal choice of **which LEVEL** (unit vs integration vs E2E). The recurring failure mode is **proving integration behaviour with a mock**:

- **2026-05-14 damage-number:** a unit test on `DamageNumberManager` was green; the bug lived at the `WorkerRendererClient ↔ worker` structured-clone seam. Fixed by a Playwright probe page that crosses the boundary.
- **2026-06-17 galaxy-map "no hostiles":** `LivingWorldDirector.galaxySnapshot.test.ts` (MOCK rooms) was green while a real offline wave showed zero enemies on the map. The bug lived at the director↔room seam + the `/galaxy/snapshot` aggregation. `WaveDirector.test.ts` fakes `LivingWorldRoom.factionBaseReadiness()`, so the real dispatch→`markSquadHostileToFaction`→snapshot chain was never exercised. Fixed + locked by `tests/integration/sectorRoom/waveGalaxySnapshot.test.ts`, which seeds a **real** ready base (via the harness `bases` opt), drives a **real** wave with an **offline** owner, and asserts `director.galaxySnapshot()` + the real `factionBaseReadiness().underWave` flip.

**Rule:** a behaviour that lives at a seam (worker boundary, director↔room hook, HTTP endpoint, wire) MUST be tested ACROSS that seam — mocking one side proves the wrong thing. Unit-test the pure decision logic in isolation (mocks fine there); **integration-test across real component seams (no mocks); E2E-test user-visible endpoints/render.** When unsure where a smoke-reported bug lives, write the test at the integration seam first — if it passes on the buggy build, you picked the wrong level.

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
| `galaxy-polish.spec.ts` | `@feature` | Galaxy-map-screen UI regression — no marketing banner on the post-auth galaxy map. | LOCK | 🚶 medium | KEEP |
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
| `sync-health.spec.ts` | `@feature` | W-thrust correction rate < 15% after 3 s; idle correction rate near-zero. | MEASUREMENT | 🚶 medium | **moved to `tests/perf/`** (wrap-up W4, 2026-11-09): a host-load timing lock like `robustness`; the netgate gates this signal |
| `tidi-overlay.spec.ts` | `@feature` | Phase 6b TiDi overlay — `data-sector-alert` = "Temporal Anomaly", clockRate < 0.99 within 30 s. | LOCK | 🐢 slow (75 s timeout) | KEEP |
| `warp-engage-cancel.spec.ts` | `@feature` | Phase 3b — full warp/transit state-machine roundtrip E2E: engage_transit wire → SPOOLING overlay (`data-testid="hyperspace-overlay"` + `data-transit-state="SPOOLING"`) → cancel_transit wire → DOCKED (overlay unmounts). The wire roundtrip lock the plan called the biggest Phase-3b gap; commit/arrive side covered by integration tests (warpBroadcasts / TransitOrchestrator / transitArrivalDrift / WarpScreen.transit / rearmJoinReadiness). | LOCK | 🚶 medium (~20 s; dominated by warp curtain wait, not game-time) | KEEP |
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

## Running E2E specs — the playbook

Root `CLAUDE.md` points here: read this before any server boot or E2E run. Triage a red spec with the `/e2e-triage` skill (`.claude/skills/e2e-triage/SKILL.md`).

### Stale dev servers cause "phantom" E2E failures

`playwright.config.ts` sets `reuseExistingServer: true` for both `pnpm dev:server` (port 2567) and `pnpm dev:client` (port 5173). That's convenient for the live-dev loop, but it has a sharp edge:

- If a server from a **previous session** is still listening on either port, Playwright will reuse it instead of spawning a fresh one.
- A stale Colyseus server is running pre-edit code, so its SAB layout, schema, and message shapes won't match the freshly-built client.
- A stale Vite dev server may have HMR'd into an inconsistent state after files were edited externally — the client either won't render the splash or will throw on init.

The classic symptom is a flood of timeouts starting from `boot.spec.ts` ("heading not found"), which is a client-only test that should be impossible to fail unless Vite is broken.

**Whose server is it?** Several Claude sessions share the machine, so a listener on 2567/5173 is not automatically yours. Stop only the processes this session or worktree started (the worktree path is in the PID's command line); another session's server is never yours to kill, even on the canonical ports — use an offset lane (`EQX_E2E_PORT_OFFSET`, below) instead. When the stale server IS yours, kill it and boot a fresh one rather than dodging onto an ad-hoc port like `PORT=2568` with your own leftover still running (that just leaves zombies behind).

**Before any server boot or E2E run:**

```powershell
netstat -ano | findstr ":2567 :5173" | findstr LISTENING
# For each PID: check its command line; stop it only if this session/worktree started it
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select-Object CommandLine
Stop-Process -Id <pid> -Force
```

Then run `timeout 8 pnpm dev:server` (boot smoke) or `pnpm e2e` normally. For diagnostic E2E runs, set `$env:CI='1'` so Playwright always spawns a fresh server — but if a stale one of yours is already in the way, kill it first.

Do not change `reuseExistingServer` to `false` casually — that breaks the live-dev loop for both sides. The right pattern is: kill (your own), then boot, then run.

### Playbook

Playwright runs are slow (a single spec can take 30–120 s; the full suite is multi-minute). The original concern was that a synchronous `pnpm e2e` call would appear to "stall" the harness — that's still true if you run the *whole suite* in foreground, but targeted runs are fine and you have permission to do them.

> **Feature specs run when their area changes (2026-11-06 audit).** CI's only required e2e gate is the smoke tier. The advisory `e2e-feature-affected` job also runs the feature specs for the areas a PR touches, from the map in `tests/e2e/featureTriggers.mjs`; a changed spec always runs itself. When a fix touches an area, add or keep its specs in that map. Known-failing specs sit in its `QUARANTINE` list (see `docs/refactors/test-coverage-audit.md`): remove the entry in the PR that fixes one.
>
> **`waitForFunction(fn, arg?, options?)`:** the second argument is the function's ARG. Write `waitForFunction(fn, undefined, { timeout })`, or the deadline is ignored (a lint rule enforces it).
>
> **Measurement specs live in `tests/perf/`, never in `pnpm e2e`.** Fixed-window heap/allocation/bandwidth/worker-A-B specs that hold a wall-clock window to gather a number (and are inherently host-load-variance-prone) run **only** via `pnpm e2e:perf` (`playwright.perf.config.ts`, 150 s per-test cap) — they are NOT part of the per-PR `pnpm e2e` regression suite. Adding a spec that waits out a fixed window for a measurement? It belongs in `tests/perf/`, not `tests/e2e/`. See `docs/refactors/test-coverage-audit.md` + the Determinism-refactor section above.

> **Parallel E2E lanes: `EQX_E2E_PORT_OFFSET=N`** (integer, default 0). Playwright then boots its own game server on 2567+N and Vite on 5173+N (`--strictPort`, HMR 24678+N, proxy → 2567+N) and every spec/helper URL follows, via `tests/e2e/helpers/ports.ts` (never hard-code `localhost:2567`/`5173` in a spec; `PLAYWRIGHT_BASE_URL`/`PLAYWRIGHT_SERVER_URL` still override). A non-zero offset is its own lane and never reuses an existing server, so a taken port fails loudly. Pick a free N per worktree (check `netstat -ano | findstr LISTENING` for 2567+N/5173+N first), e.g. `EQX_E2E_PORT_OFFSET=410 pnpm e2e tests/e2e/boot.spec.ts`. Offset 0 is the canonical pair, unchanged (reuse included). Covers `playwright.config.ts` and the netgate driver (`NETGATE_PORT_OFFSET=N` hands its Playwright run `EQX_E2E_PORT_OFFSET=N`); the perf/diag/mobile configs still use 2567/5173.

**Default playbook:**

1. **Tell the user before you start, with the expected duration and Bash timeout.** Format: `> Running tests/e2e/foo.spec.ts — expect ~60 s, Bash timeout 90 s.` Do NOT fabricate wall-clock times (e.g. "17:02 → 17:04"); the model has no real clock and inventing one is dishonest. Announce duration + cap; the user has their own clock. Mandatory for any operation whose worst-case runtime is over 2 minutes.

   **Tight-first timeouts: 3 fast timeouts beat 1 hung call.** Set the Bash `timeout` to *expected* runtime + ~30 % cushion, NOT a comfortable 2× or 3× ceiling. If it times out, you re-run with a longer ceiling — that's cheap. If it hangs, you burn the user's wall-clock and budget. Especially critical when the user is on remote control.
2. **Always narrow scope first.** Run only the new/changed spec, not the whole suite:
   ```
   pnpm e2e --project=chromium tests/e2e/foo.spec.ts --reporter=line
   ```
   Use `--grep "test name"` to narrow further if a spec has many cases.
3. **Always pass `--reporter=line`** (or `--reporter=dot`). The default `list` reporter emits ANSI cursor moves that confuse non-TTY captures.
4. **Always pass an explicit Bash `timeout` argument** — set it to ~1.5× your expected runtime, capped at 10 minutes (the Bash tool max). E.g. for a spec you expect to take 60 s, pass `timeout: 120000`. This guarantees the call returns control even if Playwright wedges, instead of burning the harness's wall-clock waiting for stdio.
5. **For the full suite** (more than one spec, or a spec known to take > 5 minutes), prefer `run_in_background: true` AND **always redirect to a log file**. The harness's completion notification can be delayed for minutes or lost entirely — do NOT use it as your primary signal. The Read tool is non-shell and instant; reading a log file is the reliable check.
   ```
   pnpm e2e --reporter=line *> e2e.log; "EXIT=$LASTEXITCODE"
   ```
   After kickoff, do other useful work for the expected runtime, then `Read` `e2e.log`. If the file ends with `EXIT=N`, the run is done. If the file hasn't grown in 2× expected runtime, kill the process — a hung run is more expensive than a forced restart.
6. **One project at a time** (`--project=chromium`). Don't fan out to all browsers from inside Claude unless the user asks.
7. **For *diagnostic* loops** — when you've added logs/probes to server code and need to be sure the running process executes them — set `$env:CI='1'` (PowerShell) or `CI=1` (bash). Playwright treats CI as `reuseExistingServer: false` and spawns a fresh server, bypassing the stale-process trap described above. Bus handlers registered in `onCreate` capture closure references that survive `tsx watch` module reloads, so without `CI=1` your edits will silently miss in any pre-existing room instance.

Treat unit tests + typecheck + lint + the 8-second server boot as the inner loop you run on every change; treat targeted E2E specs (1–2 files, narrowed by `--grep`) as the outer loop you run once the inner loop is green and you've told the user to expect a wait. The full suite is still typically the user's call, but you can run it in the background when warranted.

## Bespoke gameplay triggers — catalogue + design rules

> **`breakInMs`** (room opt, testMode, C2): every break-in takes this many ms, so a break-in test resolves in under a second (`tests/integration/sectorRoom/breakIn.test.ts`).

**The principle:** E2E tests must be **highly controlled and tightly scoped**. Target wall-clock per test is **1-2 seconds** wherever game logic allows. When a test needs longer, almost always the right move is to **add a bespoke server-side gameplay trigger that bypasses the game-time wait**, NOT to expand the timeout. Bumping the budget hides the real signal, invites flakes, and silently breaks again on the next gameplay-tuning PR.

### Triage flow (when a test needs > 30 s default)

1. *What gameplay state am I waiting for?*
2. **Infrastructural cost** (page navigation, browser cold-boot, Colyseus join + first snapshot, Vite cold-compile) — a budget bump is reasonable. Not under test control.
3. **Game-time cost** (TTK, projectile travel, shield regen, warp spool, respawn delay, ghost TTL, snapshot cadence convergence) — **find or add a bespoke trigger**. The new primitive pays for itself within 2-3 tests.

### Catalogue

| Primitive | Purpose | Where | Caveat |
|---|---|---|---|
| `initialHull: number` | Override spawn HP. `1` = one-tick-kill. | `JoinOption`, testMode-only. `tests/e2e/helpers/gameScenario.ts:TestClientOpts.initialHull` | `data-hull-pct` is a percent against `maxHealth` (~750 post-slow-down), so `initialHull=1` rounds to 0 % at spawn — use `10` (~1 %) when the test needs hull-pct > 0 at spawn. URL `?initialHull=N` or `launchTestClient({ initialHull: N })`. |
| `initialShield: number` | Override spawn shield. `0` = first beam hit lands hull. | Same as above. | None — shield is transient. URL `?initialShield=N` or `launchTestClient({ initialShield: N })`. |
| `testTimeScale: number` | Multiplies physics-tick dt. The `test-sector-fast` room ticks 10×. Ghost TTL (500 ms) → 50 ms wall-clock; projectile lifetime (4 s) → 400 ms; warp spool (30 s) → 3 s. | Room option (`src/server/index.ts` definition). | `state.clockRate` stays unmultiplied (audio + TiDi UI unaffected). Only physics speeds up; network cadence (20 Hz) and broadcasts stay at real-time. Use `launchTestClient({ room: 'test-sector-fast' })`. |
| `testId: string` + `filterBy(['testId'])` | Per-test room isolation. Each unique testId routes to its own room. Multi-client tests share an explicit testId. | `JoinOption` (clients) + `filterBy` on the room definition (`src/server/index.ts:test-sector` + `test-sector-fast`). | Use `randomUUID()` at the test level; pass to every `launchTestClient` / `joinClientAt`. Tests that don't pass a testId share a default room (back-compat). `launchTestClient` itself defaults to `randomUUID()` per call, so a multi-client test MUST mint one testId and pass it to every client. |
| `dronePoses: [{kind, x, y, angle?, hullExposed?}]` | Deterministic drone placement at hand-authored world poses, bypassing the uniform-disc spawner. `hullExposed: true` drops shields at spawn so the polygon collider is active immediately. Used by `hull-collision-test` + `hull-collision-overlap-test` rooms. | `roomOpts` field in `SectorRoom` (testMode-gated). `src/server/rooms/SectorRoom.ts` `useDronePoses` branch. | Static-overlap collision detection via `data-pred-stats.collisionEventsApplied` does NOT work for drone-vs-drone (client predWorld keys are `swarm-${entityId}`, not the server's drone IDs). Use server-side `/dev/events` (filter by `tag === 'collision_resolved' \|\| 'ram_damage'` and the pair's `aId`/`bId`). See `tests/e2e/t-ship-no-self-collision.spec.ts`. |
| `startHostile: boolean` | Pre-mark every drone in the sector hostile to the joining player at spawn — first frame is steady-state combat, no IDLE→COMBAT transition. Mirrors LivingWorldBotHooks `markBotHostile` (per-drone `aiController.markHostile` + `bot_aggro` broadcast). | `JoinOption`, testMode-only. URL pass-through `?startHostile=1` in `src/client/app/gameSurfaceBootstrap.ts`. Wired post-spawn in `src/server/rooms/SectorRoom.ts` onJoin. | Used by `tests/perf/combat-allocation-profile-hostile.spec.ts` (plan: imperative-taco) for a clean CDP allocation-profile window. Ignored on galaxy rooms — a wire-level safeguard against malicious force-aggro. |
| `lingerMs: number` | Override the per-player disconnect-linger TTL (ms). Lets the linger E2E observe the despawn→return-to-pool transition in ~2 s instead of the 15-min `LIMBO_DISCONNECT_TTL_MS` window. | `JoinOption`, testMode-only. URL pass-through `?lingerMs=` in `gameSurfaceBootstrap.ts`; captured per-player in `SectorRoom.onJoin` (`playerToLingerMs`), threaded into `LeaveHandler` for both the Limbo window AND the ownerless-evict timer; cleared on leave. | Galaxy-only (lingering requires `sectorKey !== null`); use the `galaxy-test` room. Drives `tests/e2e/linger/*` + `tests/integration/sectorRoom/lingerDespawnReturnsToPool.test.ts`. |
| `instantLock: boolean` | Lock-to-fire (#19) without the wait: every lock of this pilot completes on the next lock step (≤ 100 ms; a failsafe still commits its hostile act). AUTO targeting is unchanged (hostile only). The trigger for every spec that fires but isn't about locking. | `JoinOption`, testMode-only. URL `?instantLock=1` in `gameSurfaceBootstrap.ts`; `TestClientOpts.instantLock`. Integration: `harness.lockTarget(pid, target)` (`_internals.forceLock`). | Fixed guns still fire only with the target within 0.2 rad of the nose. Lock: `LockSubsystem.test.ts`. Specs ABOUT locking use the `lockOn` helper (`tests/e2e/helpers`). |
| `lockTimeCapS: number` (room opt) | Lock-to-fire for NON-player guns without the long wait: no lock by an NPC drone / capital (on a pilot), a capital turret (on a structure) or a structure / coastal turret takes longer than N s while in reach; 0 = the first lock step. Still acquired (#19), only faster. Big-gun locks are slow by design; this is for tests and recordings. | Room option read in `SectorRoom.onCreate` (zod, testMode), or the room-creating client's join option: URL `?lockTimeCapS=N` (`gameSurfaceBootstrap.ts`), `TestClientOpts.lockTimeCapS`, a showcase shot's `target.params`. Integration: `bootSectorTestServer({ lockTimeCapS })`, `_internals.structureTurretLock(id, i)`. Math: `capLockSeconds` (`core/combat/lockTime.ts`). | In reach only (out of reach stays unlockable; a lock the rules call impossible but in reach takes N). No existing room or shot sets it: a shot opts in deliberately. Player locks use `instantLock` (an N-s player cap would split the client's lock-ring prediction, #15). Lock: `lockTime.cap.test.ts`, `capitalLockGate.test.ts`, `StructureMountTicker.test.ts`, `tests/integration/sectorRoom/lockTimeCap.test.ts`. |
| `chargeTicksCap: number` (room opt / join opt) | No capital-turret charge (the railgun's 6 s wind-up) lasts longer than N ticks; 0 = fire on the next tick it may. Lets a test line ships up on a rail line and fire without the wait. | Room option read in `SectorRoom.onCreate` (zod, testMode), join option (testMode or `EQX_ALLOW_DEV_OVERRIDES`): URL `?chargeTicksCap=N`, `TestClientOpts.chargeTicksCap`. Integration: `bootSectorTestServer({ chargeTicksCap })`. Applied by `WeaponMountTicker.chargeTicksOf`. | Capital turrets only (the robot salvo path keeps its charge). The client telegraph still ramps over the weapon's own charge. Lock: `tests/integration/sectorRoom/railgun.test.ts`. |
| `traverseTicksCap: number` (room opt / join opt) | No capital turret takes longer than N ticks to train a full turn (a 16" trains at ~4°/s, ~15 s onto a target abeam); 0 = it snaps onto its bearing. Lets a test watch a capital's turrets charge and fire in a second or two. | Room option read in `SectorRoom.onCreate` (zod, testMode), join option (testMode or `EQX_ALLOW_DEV_OVERRIDES`): URL `?traverseTicksCap=N`, `TestClientOpts.traverseTicksCap`. Integration: `bootSectorTestServer({ traverseTicksCap })`. Applied by `WeaponMountTicker.traverseDt`. | Capital turrets only (player and drone slot mounts keep their rates: a player's are predicted on the client, #15). Drawn turrets follow the snapshot `mountAngles`, so they snap too. Lock: `tests/integration/sectorRoom/railgun.test.ts`. |
| `timeScale: number` (room opt / join opt) | This SECTOR's game speed, 0.25–4× (time scale stream, per sector): the room's clock, timers, update loop and physics world all run at it; snapshots carry the `timeScale` keyframe while it isn't 1. For demos, videos and slow motion. | Room option read in `SectorRoom.onCreate` (zod, testMode); join option (testMode or `EQX_ALLOW_DEV_OVERRIDES`): URL `?timeScale=N` (`gameSurfaceBootstrap.ts`), `TestClientOpts.timeScale`; env `EQX_TIME_SCALE` (every sector, not in production); `POST /dev/time-scale?room=<roomId|sectorKey>&scale=N`. Integration: `bootSectorTestServer({ timeScale })`. | Stream-only until it lands. The client does not follow it until Phase 4 of the stream (expect prediction corrections before then). `testTimeScale` stays the separate physics-only test accelerator for now. Lock: `tests/integration/sectorRoom/timeScale.test.ts`. |
| `anyTarget: boolean` | This pilot's AUTO groups also pick non-hostile NPCs and non-own structures in reach + arc. Pair with `instantLock` for a spec whose AUTO group must shoot a neutral drone / structure. | `JoinOption`, testMode-only. URL `?anyTarget=1` in `gameSurfaceBootstrap.ts`; `TestClientOpts.anyTarget`. | Never auto-picks players (use `lockOn` / `lockTarget`). Not for showcase combat takes (the pilot could fire on a neutral structure). Lock: `LockSubsystem.test.ts`. |
| `groupMode: 'manual'` | Every weapon group of the joining pilot starts in MAN, so AUTO never self-picks a target. Pair with `instantLock` (and `anyTarget`, if used) when an AUTO group (e.g. the point-defence laser) would kill a fragile target before the test switches the group it wants to AUTO. | `JoinOption`, testMode-only. URL `?groupMode=manual` in `gameSurfaceBootstrap.ts`; `TestClientOpts.groupMode`. Applied per player in `LockSubsystem.enable`. | A group the pilot switches to AUTO afterwards behaves normally. Lock: `LockSubsystem.test.ts`, `fireControlLocks.test.ts`. Example: `missile-frigate-homing.spec.ts` drone test. |
| `auto-fire-test` room | Peaceful, hull-exposed `fighter` drone parked 150 u ahead of spawn (within beam range 250). Join `?room=auto-fire-test&startHostile=1` → the drone is flagged hostile so an AUTO weapon group locks it and fires with NO input; omit `startHostile` to assert AUTO does NOT engage a neutral drone. `testTimeScale:10`. The bespoke primitive for auto-fire E2Es — `test-sector-fast` has no drones and `dronePoses` is not a URL param, so a dedicated room is required. | `gameServer.define('auto-fire-test', ...).filterBy(['testId'])` in `src/server/index.ts`. | Pair with a high `?initialHull` if the drone is non-peaceful; the default room keeps it peaceful so the player survives. Drives `tests/e2e/auto-fire.spec.ts`. |
| `galaxy-test` room | Isolated, bot-free, **linger-capable** room (real `sectorKey`, so the galaxy-only linger + abandon-poll paths fire; engineering rooms with `sectorKey===null` never linger). `droneCount:0` + `asteroidConfig:[]` → deterministic scene for screenshots; excluded from `GALAXY_SECTORS`/eager-create so the `LivingWorldDirector` routes no hunter bots. | `gameServer.define('galaxy-test', ...).filterBy(['testId'])` in `src/server/index.ts`. Reach it via `launchGalaxyTestClient` (`?room=galaxy-test&worker=0`). | Owners never see their OWN displaced lingering hull (it's rescued into `mirror.ships`), so lingering-visibility assertions need a 2nd observer client. Use `?worker=0` for screenshot-able rendering (the default OffscreenCanvas-in-worker path screenshots black). |
| `structureGridPulseMs: number` | Override the structure grid pulse interval (ms). The grid pulse (construction / mining / transfer) is a **wall-clock timer, NOT the physics tick**, so `testTimeScale` can't speed it — this is the bespoke trigger that fast-forwards construction + mining for E2E. | `JoinOption`, testMode-only. URL pass-through `?structureGridPulseMs=` in `gameSurfaceBootstrap.ts`; reaches `onCreate` on the room-creating client. Default `TRANSFER_PULSE_MS` (1000). | Min 20 ms. Turret fire stays on the fixed `TURRET_TICK_MS` (100 ms) cadence — this only scales the logistics pulse. |
| `initialXp: number` | Pre-load the joining ship's roster XP so ONE kill crosses a level threshold (level-up icon, badge, upgrade modal) instead of ~8+. | `JoinOption`, testMode-only. URL pass-through `?initialXp=` in `gameSurfaceBootstrap.ts`; applied in `SectorRoom.onJoin` via `PlayerShipStore.setProgress`. | Needs a roster row ⇒ a room with a real `sectorKey` (e.g. `showcase-levelup`); engineering rooms ignore it. Level is unchanged — only XP. Lock: `tests/integration/sectorRoom/showcaseRooms.test.ts`. |
| `initialCargo` / `initialWallet` (URL) | Start with goods aboard / a wallet balance, so a hauling or trading take needs no farming first. | URL `?initialCargo=salvage:40,alloy:12` and `?initialWallet=N` in `gameSurfaceBootstrap.ts` → the existing testMode JoinOptions. | Cargo needs a roster row (a room with a real `sectorKey`, e.g. `showcase-homestead`). |
| `dronePoses[].elite` (room opt) | Make a posed drone a named elite with a bounty, on cue (the EliteDirector only sends elites on its own schedule). `{ name, healthMul?, bounty? }` → `SectorRoom.markElite`. | `SectorRoom.onCreate` `useDronePoses` branch (testMode). Room `showcase-bounty`. | The bounty pays a killer's wallet ⇒ roster-backed room. Lock: `tests/integration/sectorRoom/showcaseRooms.test.ts`. |
| `prebuiltStructures` / `scenarioDrones` / `scenarioAsteroids` (room opts) + the `structure-scenario-test` room | Seed a PRE-BUILT, auto-connected, **powered** grid + parked drones + asteroids, owner `scenario`. The bespoke primitive for structure E2Es: the place-ahead Build UI stacks multiple placements at one spot (overlap → rejected), so a multi-structure grid can't be built via the UI — and construction takes seconds. This seeds the end state directly. | Room-definition opts read in `SectorRoom.onCreate` (`seedStructureScenario`, testMode-gated). The `structure-scenario-test` room (`src/server/index.ts`) bakes Capital+2 Solar+Miner@asteroid+Turret@drone. `_internals.{spawnTestAsteroid,spawnTestDrone,tickStructureTurrets,pulseStructureGrid}` are the integration seams. | Capital `maxConnections` is 4 — keep ≤ 4 leaves per capital. Place leaves on distinct axes (collinear leaves block each other's line-of-sight connection). Drives `tests/e2e/structure-scenario.spec.ts` + `tests/integration/sectorRoom/structureScenario.test.ts`. |
| `scaleGrid: {n, seed, fence?}` (room opt) + the `structure-scale-test` room | Seed a RULE-VALID structure lattice of N structures (Capital + connector grid + Solar/Battery/Cargo Bay/Turret leaves, optional closed Shield Pylon fence), fully built + powered, owner `scenario`. Generated server-side, so NOT bound by the 64-entry seed cap — the primitive for structure-SCALE measurement and perf arms. | `SectorRoom.seedScaleGrid` (testMode-gated): `buildStructureLattice` (`src/core/structures/structureLattice.ts`) → `place(…, {skipAutoConnect})` → `connectExplicit` (real `canConnect` re-checked). | Lattice validity is locked by `structureLattice.test.ts`. Drives `tests/integration/sectorRoom/structureScale.measure.test.ts` (ledger: docs/architecture/structure-network-scale.md). |
| `gate-test` room | Two powered Shield Gates on y = −900: west (x −400) opens for anyone not hostile, east (x 400) is owner-only and owned by `scenario`, so a visiting pilot is locked out. Spawn south with `?spawnX=±400&spawnY=-1300` and fly north. Prebuilt structures take `rot` + `gateAccess`. | `gameServer.define('gate-test', ...).filterBy(['testId'])` in `src/server/index.ts`; layout `GATE_TEST_PREBUILT` in `rooms/scenarioLayouts.ts`. | Drives `tests/e2e/gate-fly-through.spec.ts`. Integration tests that need a gate owner must join with a UUID playerId (non-UUID ids are replaced). |
| `breakInMs: number` (room opt) | Every break-in (C2) takes this long instead of the capacity/level duration (10–45 s), so a break-in E2E or integration test resolves in under a second. | `SectorRoom` (testMode-gated) → `breakInMsFor`; the integration harness forwards it. | Starting is still a hostile act (turrets, alarms). Drives `tests/integration/sectorRoom/breakIn.test.ts`. |
| `break-in-test` room | A Capital owned by `scenario` (neutral, so its cargo is locked) holding 7 alloy, a peaceful NPC fighter beside the spawn (0, −650), `breakInMs: 800`, and a real sectorKey (cargo needs a roster row). | `gameServer.define('break-in-test', ...).filterBy(['testId'])` in `src/server/index.ts`. | Spawn NORTH of the Capital (`?spawnX=0&spawnY=650`) when the test clicks its inspector. Drives `tests/e2e/break-in.spec.ts`. |
| `teleportCycleScale` / `pairTeleporters` (room opts) + the `teleport-test` room | v4 T1 teleporters. `teleportCycleScale` speeds the jump cycle (0.1 ⇒ ~1.4 s); `pairTeleporters` pairs the seeded teleporters in order. The room seeds a powered Capital (50 alloy) with a teleporter on each side, paired, owned by `face0000-0000-4000-8000-000000000002`, and pulses the grid every 100 ms. | `SectorRoom` (testMode-gated); room in `src/server/index.ts`; the integration harness forwards both. `teleport-toll-test` is the same layout at half speed (~6 s from arming to the swap), so a toll prompt can be answered in time. | Join as the owner (anonymous context, `localStorage eqxPlayerId`) to use the controls. Drives `tests/e2e/teleporter.spec.ts` + `tests/integration/sectorRoom/teleporter.test.ts`. A second page in the same test should not use `worker=0` (two main-thread renderers starve each other). |
| `testAlienGate` (room opt) + the `alien-gate-test` room | One Ancients' gate (no twin) at the origin, pilot spawning inside its 2500 u zone: fire and you're disabled. The two-room ride and the timetable are covered by the multi-sector integration harness (`alienGates: true` + `teleportCycleScale`, which also shortens the minute). | `SectorRoom.onCreate` (testMode-gated); room in `src/server/index.ts`. | Drives `tests/e2e/alien-gate.spec.ts`. Never give a test room a real galaxy sector key: it would register with the teleport broker in place of the live room. |
| `npcBases` (room opt) + the `npc-base-<tier>` rooms | NPC bases grown by the production-chain generator (`growBase`): placed under the real rules, built, owned by `npc:<side>:<baseId>`, recipes and bound blueprints loaded, stocked with fuel, munitions and inputs. The rooms are `npc-base-outpost` (mining), `npc-base-settlement` (refinery), `npc-base-stronghold` (manufactory) and `npc-base-citadel` (assembly works); the pilot spawns south of the fence. | `SectorRoom.seedNpcBases` → `bases/NpcBaseSubsystem.ts`; rooms in `src/server/index.ts`. | Not persisted (regenerated from the seed). Drives `tests/integration/sectorRoom/npcBases.test.ts`. |
| `tradeEnabled` / `seedStorageHold` / `haulerRaiders` (room opts) + the `trade-test` / `trade-showcase` rooms | Trade E2Es/showcases without flying cargo home. `tradeEnabled` joins the TradeDirector (per-room key `<sectorKey>#<roomId>`, registered lazily on the first trade request, so a room created before boot finished still trades). `seedStorageHold` stocks any storage structure the player PLACES. `haulerRaiders: n` spawns n robot cubes partway along each incoming hauler's route (the raid / escort on camera). | `SectorRoom.onCreate` (testMode-gated). Rooms in `src/server/index.ts`. | Guests can trade (economy v2: guests are full players); the default Playwright `page` fixture still works. Drives `tests/e2e/trade-tab.spec.ts` + `tests/showcase/trade-p2.spec.ts`. |
| `persistSector: false` (room opt) | A test room that needs a real `sectorKey` (roster, cargo, trade) but must not save or restore the sector snapshot. Every instance of one key shares one saved snapshot, so without it a test's structures come back in the next run's room on a reused dev DB (CI's DB is fresh, so it hides there). | `SectorRoom` (testMode): `SectorPersistence` sees no sector key. `trade-test` sets it. | Found by the 2026-11-06 audit (cargo-panel placed onto an old Capital and was refused). |
| `sceneScript` (room opt) | A timed list of world events for a perf scene: `spawn` N ships of a kind in a deterministic disc at a time (`warpIn` shows the warp-in effect, `hostile` marks them hostile to every pilot), `fleet` gives the first pilot N PARKED hulls (roster rows + lingering hulls) flown by wingman brains in a `mode` / `stance`, with optional `health` (the `rts-fleet` scene), then `end`. The clock starts when the first pilot is ready. Drones and robots spawned together fight on sight, so a fleet fight needs no extra order. | `SectorRoom.initSceneScript` → `rooms/scene/SceneScriptRunner.ts` (zod-validated, testMode-gated, ≤ 64 steps / ≤ 64 ships a step). `sceneStatus()` reports started / spawned / refused / ended. | A refused spawn (slot pool full) makes a perf run invalid. Ships start out of weapon range only if you want an approach; place the sides within a few hundred units for an immediate fight. Lock: `SceneScriptRunner.test.ts` + `tests/integration/sectorRoom/sceneScript.test.ts` + `rtsFleetScene.test.ts`. |
| `test_aggro` message + the `showcase-capital-duel` room | `test_aggro` (testMode) turns every drone in the room hostile to the sender NOW, the same as `startHostile`, so a shot starts a fight after its art has baked. Hostility decays 30 s after the latest of: the pilot's last hit on the drone, the end of the pilot's last lock on it (2026-11-10), the drone's last hit on the pilot, or the end of the drone's own last lock on the pilot (an attacking NPC stays hostile, 2026-11-12; its lock drops out of reach, so a pilot who leaves is forgotten 30 s later); a showcase take sends it once before recording and never re-sends it during the take (record as is). The duel room is one battleship at the origin and the pilot 4,000 u off its starboard beam (`showcase-capitals-combat` is the five-capital line-up with live brains). | `SectorRoom.markAllDronesHostileTo`; schema `TestAggroSchema`; rooms in `rooms/showcaseRooms.ts`. | At the real 4°/s a 16" turret needs ~25 s to train onto the beam; cue the fight before recording. The integration test starts the battleship bow-on so its forward turrets already bear. Lock: `tests/integration/sectorRoom/capitalEngagement.test.ts`. |
| `capitalWrecks` (room opt) | Capital destruction S2a: a dying capital (NPC or player-flown) breaks into solid wreck bodies on the server (swarm kind 4, server-only). **ON by default in every room** (owner 2026-11-14: "land it switched on"); `capitalWrecks: false` opts a room out, and `EQX_CAPITAL_WRECKS=0` forces it off everywhere (`=1` on), `rooms/wreckSwitch.ts`. | `SectorRoom.initCapitalWrecks` → `rooms/CapitalWreckSubsystem.ts`; the integration harness forwards it. Seams: `_internals.wreckState` / `wreckParts` / `setWreckSeed` / `rayHit`. | A test whose counts or kills must not leave pieces opts out (room option `false` or env `=0`); don't switch it off for a room players fly. Lock: `tests/integration/sectorRoom/capitalWrecks.test.ts`, `wreckSwitch.test.ts`. |
| `subcapWrecks` (room opt) | Sub-capital break-up slice 2: every polygon sub-capital (havok keeps its scrap) breaks into 2-3 permanent wreck pieces through the same wreck system, no crack hold, pieces that ignore each other and settle to SLEEP in ~15 game s. **ON by default in every room** (owner 2026-11-14); `subcapWrecks: false` opts a room out, `EQX_SUBCAP_WRECKS=0` forces it off everywhere (`=1` on). One death effect per ship: a breaking kind never also sheds scrap (`oneDeathEffectPerShip.test.ts`). | `SectorRoom.wreckKindAllowed` → `rooms/CapitalWreckSubsystem.ts`; the integration harness forwards it. Seams: `_internals.swarmSleeping` / `wreckCounts` / `setSubcapWreckCap`. | Same opt-out rule as `capitalWrecks`. Lock: `tests/integration/sectorRoom/subcapWrecks.test.ts`. |
| `test_kill_capitals` message + the `wreck-test` room | Capital destruction: every capital NPC in the room takes a lethal hit NOW (re-hit through a shield), so a spec sees the wreck without a gun duel. The room holds a peaceful battleship 2.5 km north of the spawn with `capitalWrecks` on. | `SectorRoom` (testMode); schema `TestKillCapitalsSchema`; room in `src/server/index.ts`. | Drives `tests/e2e/capital-wreck-render.spec.ts`; integration lock in `wreckLateJoiner.test.ts`. |
| `injectLeak: number` | Mobile-perf gate regression-lock — retains `N` bytes per RAF tick on `window.__testLeak` so the `jsHeapGrowthMb` budget metric can be exercised end-to-end. DEV-build only (Vite tree-shakes the hook from prod via `import.meta.env.DEV`); the URL param alone does nothing in a production deploy. | URL `?injectLeak=N` (e.g. `102400` = 100 KB/tick) or `launchTestClient({ injectLeak: N })`. Server-side accepts and ignores — the value is consumed client-side by `src/client/debug/testLeakHook.ts`. | Used by `tests/mobile-perf/heap-budget-injected-leak.spec.ts`. |
| `testWaveArrival: { x, y }` (room opt) | Where a WAVE squad lands in this room instead of its carry pose (members on a 60 u ring, at rest), so the attack lands inside the spec's window. `galaxy-wave-test` uses (-900, 700): bolt reach of a Solar, outside the Turret. | testMode room option (`SectorRoom.testWaveArrival()` → `LivingWorldDirector.arrivalPoseFor`). | With `persistSector: false` on that room and a fresh director under `EQX_E2E_WAVE=1`, every run starts from the seeded ready base. |
| `waveNeedsOwner: true` (room opt) | A base in this room is wave-ready only while its owner has an active ship there. Waves ignore presence in play, so without it the wave fired at server boot and a spec that ran after others joined too late for the banner. | testMode room option, read in `SectorRoom.factionBaseReadiness`; `galaxy-wave-test` sets it. | Test rooms only. |

### Adding a new primitive

When 3+ tests would benefit from the same skip, it's worth adding a new server-side trigger. Pattern:

1. Define the JoinOption (zod schema, testMode-gated) in `SectorRoom.JoinOptionsSchema`.
2. Apply it in `onJoin` (after kind-default initialisation, before persistence write).
3. Wire URL → joinOption in the URL-param pass-through block of `buildJoinSpec` in `src/client/app/gameSurfaceBootstrap.ts` (`if (urlParams.has('myFlag')) extraJoinOptions['myFlag'] = ...`).
4. Surface in `TestClientOpts` in `tests/e2e/helpers/gameScenario.ts`.
5. Document here in this catalogue.

### Backlog (don't add until needed)

- `initialDeath: true` — spawn the ship already destroyed. Test the respawn UX without the kill setup.
- `instantWarpSpool: true` — bypass the 30 s spool. Test warp completion + arrival binding without 30 s of waiting.
- `bypassJoinGrace: true` — skip the 5 s `JOIN_BROADCAST_GRACE_TICKS` snapshot window. Useful for post-warm-up assertions.
- `pinnedDronePoses: Array<{id, x, y}>` — deterministic drone placement instead of default scatter.
- `weaponCooldownTicks: 1` — per-tick fire mode. Lets ghost / projectile tests fire many shots in sub-second wall-clock.

### Anti-patterns (reject in code review)

- `test.setTimeout(N_MUCH_LARGER)` without a corresponding game-time trigger added — bumping the test budget to "fix" a TTK problem is hiding the defect, not solving it.
- `await page.waitForTimeout(N)` to pace past a game-time wait — use `waitForFunction(state predicate)` with the same N as a *deadline*, while triggering the state through a bespoke flag instead of pacing.
- Hardcoded `expect(duration).toBeLessThan(N)` that assumes pre-tuning TTK / cooldown — express expectations against the gameplay state being tested, not the wall-clock to reach it.
- Tests that only fail when a recent gameplay-tuning PR landed — that's not a test infrastructure problem, it's a test-design defect that the framework should surface and fix at the source.

### Proof the philosophy pays off (2026-05-20 vanity stat)

Smoke suite went from 31 pass / 19 fail / ~15 min → **41 pass / 3 fail / 6 skipped / 8.3 min** — same 50 tests, sequentially executed on the same box. Per-test repair work mostly meant "add the right primitive" (the `initialHull/initialShield` server-side override, the `testTimeScale` room option, the `filterBy(['testId'])` per-test rooms) — not "bump the timeout."


## Project-local skills (Phase 4c, 2026-05-20)

Two slash commands live in `.claude/skills/` so any dev who clones the repo gets them automatically (Claude Code auto-discovers `.claude/skills/<name>/SKILL.md`):

| Skill | When to use | What it does |
|---|---|---|
| `/netgate` | After live-loop-touching changes (anything under `src/client/net/`, `src/core/prediction/`, `src/core/physics/`, render loop, snapshot decode/interpolate, mount aim, `SectorRoom` tick/snapshot). | Runs `pnpm e2e:netgate [<baselineRef> <headRef>]`, parses the verdict stanza (baseline + HEAD stat blocks + REGRESSION lines + PASS=...), reports pass/fail with the offending metric + magnitude, suggests `git bisect run pnpm e2e:netgate` on RED. The front door to Phase 1. |
| `/e2e-triage <spec.ts>` | When a `@smoke` or `@feature` spec is failing and you want to know if it's locator drift, timing, or a real regression. | Re-runs the spec in isolation, classifies the failure (LOCATOR_DRIFT / TIMING_RACE / REAL_REGRESSION), proposes a deterministic fix. **For TIMING_RACE the fix MUST be a bespoke trigger, never a timeout bump.** Refuses `@gate` triage — routes to `/netgate` instead so a margin-loosening "fix" is impossible via this skill. |

Phase 4a (Playwright `init-agents --loop=claude` planner / generator / healer) needs Playwright v1.56+; this repo is on 1.49.0. Deferred until the upgrade lands as a separate dependency story — agents are breadth-only per the plan, gates AI-fenced.

## Unit and component test layers

**Test layers** (introduced for Phase 5):
- `vitest` `*.test.tsx` files run under `jsdom` (per-file env via `vitest.config.ts` `environmentMatchGlobs`); `*.test.ts` continues to run under `node` (server logic, schemas, helpers).
- `@testing-library/react` + `@testing-library/jest-dom` for component assertions. Matchers registered in `vitest.setup.ts` (dynamic-imported only when `typeof document !== 'undefined'` so node-env tests don't pay the cost).
- `@testing-library/user-event` available for keyboard/text-input flows when needed; the existing Phase 5 tests use `fireEvent.click` for button activations.
- `fast-check` is installed for property-based testing of pure functions (use when the surface naturally benefits — Phase 6 has more candidates than Phase 5).
- `@colyseus/testing` is installed for in-process room integration tests; the version pinned in `package.json` reports a peer-dep mismatch (0.17.x vs colyseus 0.16) — re-pin to 0.16-compat when Phase 6b lands and actually exercises it.
- `@stryker-mutator/core` + `@stryker-mutator/vitest-runner` are installed for mutation testing; configuration deferred until Phase 6 ships (the suite needs stable tests to mutate).

## History

- **Why the bespoke-trigger rule exists (2026-05-17).** The slow-down-gameplay PR (+50 % shield + hull, 10× warp spool) silently broke every combat smoke spec that assumed pre-tuning TTK. The wrong fix was bumping timeouts (15 s → 30 s → 45 s); the right fix was the `initialHull=1` / `initialShield=0` server-side override that makes a 1-tick kill test possible. The bump-pattern would have broken again on the NEXT tuning pass; the bespoke trigger is invariant under future combat-tuning changes.
- **Feature specs rotted unseen (2026-11-06 audit).** Before the advisory `e2e-feature-affected` job ran the `featureTriggers.mjs` map, ~30 feature specs rotted unnoticed because nothing ran them.
- **Server ownership (2026-11-08).** The stale-server policy used to say anything listening on 2567/5173 was Claude's and safe to reclaim (the user drives sessions by phone and keeps no dev server of their own). Since several sessions share the machine, it is "stop only what your session or worktree started; use an offset lane for the rest".
