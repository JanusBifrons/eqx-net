# CLAUDE.md — EQX Peri (Root)

You are working in **EQX Peri**, a multiplayer space game. This file is your north star; read it before making any non-trivial change. Zone-specific rules live in:

- [src/core/CLAUDE.md](src/core/CLAUDE.md)
- [src/server/CLAUDE.md](src/server/CLAUDE.md)
- [src/client/CLAUDE.md](src/client/CLAUDE.md)

Non-obvious lessons learned during implementation go in [docs/LESSONS.md](docs/LESSONS.md).

The Master Architecture Blueprint is the authoritative design document; the approved phased plan file (under `C:\Users\alecv\.claude\plans\`) is the executable roadmap. When the blueprint and a zone CLAUDE.md appear to disagree, the most recently-updated CLAUDE.md wins (it reflects what was actually learned while building).

---

## Cross-Phase Invariants (ALL must hold at every phase gate)

1. **Boundary integrity.** `src/core` imports no client or server library. `src/server` imports no client library. `src/client` imports no server-only package or Node-only API. CI-enforced via `eslint-plugin-import` `no-restricted-imports` **and `dependency-cruiser`** (`.dependency-cruiser.cjs` encodes the same boundaries as a real module graph; the `verify` CI job runs `depcruise src`). The canary fixture at [src/core/\_\_fixtures\_\_/leak.ts.disabled](src/core/__fixtures__/leak.ts.disabled) exists to prove this enforcement is live; toggling its extension must break CI (it trips BOTH the ESLint rule and depcruise's `core-no-ui-or-node-libs`).
2. **Zustand purity.** No spatial field (`x`, `y`, `vx`, `vy`, `angle`, `rotation`, `position`, `velocity`) may appear in the Zustand store. Lint rule in `eslint.config.js` blocks it. Spatial state lives in the render mirror polled by Pixi; UI state lives in Zustand.
3. **Network validation.** Every inbound server message has a zod schema. Malformed packets are dropped with a sampled `pino.warn` — they never reach game logic.
4. **Fixed timestep.** `world.step(1/60)` inside a `while (accumulator >= fixedDt)` catch-up loop. No variable-dt physics anywhere.
5. **DI seams.** `src/core` never constructs a renderer / audio / network sink / persistence. Implementations are injected by the appropriate zone at bootstrap via the contracts in `src/core/contracts/`.
6. **SOLID adherence** (see below). Enforced at code-review time.
7. **CLAUDE.md currency.** Every PR that changes an invariant, adds a contract, introduces a threshold, or teaches a non-obvious lesson updates the relevant CLAUDE.md file in the same PR. If you find yourself about to merge without updating CLAUDE.md, stop and ask whether this PR is actually teaching something.
8. **Green bars before done.** `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e && pnpm bench` all pass. For any change touching the live-loop (client `net/`, `prediction/`, physics, render loop, snapshot decode/interpolate, mount aim, `SectorRoom` tick/snapshot), **`pnpm e2e:netgate` baseline-relative-green is also required** — the deterministic suite verifies logic in isolation and is not a playability signal (2026-05-19 incident; see "Netcode-health gate" section below + `docs/LESSONS.md` 2026-05-19/20).
9. **Tests accompany every behavioural change.** Any PR that changes physics behaviour, prediction logic, obstacle sync, or collision handling MUST include a new or updated E2E test in `tests/e2e/` that would have caught the regression. "I manually verified it works" is not sufficient — manual checks are not repeatable and do not protect future PRs. If no test is added, the PR is incomplete.
10. **Documentation as a shipped artefact.** Every major feature ships with at least one prose guide under `docs/features/` (player-facing behaviour) or `docs/architecture/` (system internals). [`docs/LESSONS.md`](docs/LESSONS.md) captures gotchas; CLAUDE.md captures rules; `docs/` captures the *story* — the why, the migration path, the future plans. See `docs/architecture/galaxy-graph.md`, `docs/architecture/persistence-and-migrations.md`, and `docs/architecture/ship-physics-handling.md` for examples.
11. **Ship-kind catalogue is append-only.** The single source of truth for ship types is [src/shared-types/shipKinds.ts](src/shared-types/shipKinds.ts). The catalogue's `SHIP_KINDS_LIST` order is part of the swarm wire format (drone kinds encode as a `u8` index). Adding a new kind: append a record. Removing or reordering kinds: bump `SWARM_WIRE_VERSION` and verify decoder hard-fails on the old version. See [docs/features/ship-kinds.md](docs/features/ship-kinds.md). **The same append-only contract binds [src/shared-types/structureKinds.ts](src/shared-types/structureKinds.ts)** — `STRUCTURE_KINDS_LIST` order is the structure subtype index that rides the *shared* `shipKind` u8 byte when the pose-core `kind` is 2 (so a structure subtype and a drone ship-kind never collide — they're demuxed on `kind`). Append a record + bump `STRUCTURE_KIND_CATALOGUE_VERSION`; never reorder/remove. See [docs/architecture/structures-and-power-grid.md](docs/architecture/structures-and-power-grid.md). **Ship VISUAL shapes can be COMPOSITE** (`ShipShape` is a discriminated union `polygon | composite`; `composite` carries a single `hull` for the live collider + `parts[]` for the multi-component visual, all read through the `shipHullOutline(kind)` seam so polygon kinds stay byte-identical). On death a composite ship breaks into one **scrap** swarm entity per component: `SWARM_KIND_SCRAP = 3` rides the binary wire with a new `componentIndex` u8 (the shared `shipKind` byte carries the PARENT ship-kind index, demuxed on `kind`), which bumped `SWARM_WIRE_VERSION 3 → 4` (decoder hard-fails v3). Scrap geometry is looked up client-side by `(parentShipKind, componentIndex)` — never on the wire. See [docs/architecture/composite-ships-and-scrap.md](docs/architecture/composite-ships-and-scrap.md).
12. **Mount-angle state has exactly one ownership site; drone POSE has exactly one path (interpolation).** `WeaponMountController.tickSlot` (and the `pickTarget` + `rotateMountToward` primitives it composes) is the only path that may write per-mount rotation angles. The server's player update AND server's drone update (`SectorRoom.tickPlayerMounts` / `tickDroneMounts`) call it; the client's *local-player* prediction (`tickLocalMountAim`) calls it. **Drones no longer compute mount angles client-side** — post the drone-snapshot-interpolation pivot (2026-05-18) the client has no drone AI at all; it just applies the authoritative slim `SnapshotMessage.drones[].mountAngles` to the swarm mirror. Likewise **drone POSE is now pure snapshot-interpolation** off the binary swarm wire (`interpolateSwarmPose`, display-delay buffer + teleport guard); the predWorld drone body is a kinematic follower of that interpolated pose. The "chapter 2 lockstep / one correction path per state surface" concern **dissolves for drones** — there is no client drone sim, so there is no second path to fight; the rule still binds the local player's mount angles + pose. The binary swarm wire is at **v4** (composite-ships scrap-on-death added `SWARM_KIND_SCRAP` + a `componentIndex` byte, 2026-06-13; was v3); `SnapshotMessage.drones[]` is a slim turret/shield slice (`{ id, mountAngles?, shieldDown? }`) — drone x/y/vx/vy/angle/angvel flow ONLY on the binary channel. Load-bearing: `POSE_RING_DEPTH` must cover `DISPLAY_DELAY_MS` at the *in-interest binary cadence* (~1000/60 ms), not the 50 ms JSON rate (the Step-4 regression — see `docs/architecture/drone-snapshot-interpolation.md`). See [docs/architecture/weapon-mounts.md](docs/architecture/weapon-mounts.md) and [docs/architecture/drone-snapshot-interpolation.md](docs/architecture/drone-snapshot-interpolation.md).
13. **Smoke-test bug reports require a failing test BEFORE the fix.** When the user (or anyone) reports a bug from manual play / smoke testing, the response order is **non-negotiable**:
    1. **Reproduce in a test first.** Write an E2E spec in `tests/e2e/` (or an integration test in `tests/integration/`) that drives the same flow the user described and ASSERTS the broken behaviour. The test must FAIL on the current code — if it passes, the test doesn't match the bug and the test itself is wrong.
    2. **Then fix.** With the failing test as a regression lock, ship the fix and confirm the test now passes.
    3. **Commit the test + fix together.** Reverting the fix should re-fail the test. Future contributors get the bug + the lock in one history-readable unit.

    Why: the user's bandwidth for smoke-testing is finite and the burden compounds. Every bug found via manual play that we patch *without* a test means the same bug will resurface in a different smoke-test cycle. Tests are how the burden goes back down. "I manually verified" is not sufficient (already enforced by Invariant #9); this invariant is the smoke-test-specific corollary that says **the test must come first, not as a follow-up**.

    Practical workflow for a smoke-test bug:
    - Get the user's diagnostic capture (`diag/captures/<timestamp>-<id>/`); reconstruct exact steps from `lifecycle.ndjson` + `combat.ndjson` so the test mirrors the real flow.
    - Pick the test layer that's *minimal* for the bug — but **the level where the bug LIVES, not the level that's easiest to write**. If the bug is at a postMessage / structured-clone / worker boundary, the test MUST cross that boundary (Playwright + a probe page is the canonical pattern — see `src/client/__offscreen-spike__/damage-number-probe-main.ts` + `tests/e2e/damage-number-lifetime.spec.ts`). Unit-testing the inner class in isolation when the bug lives at an integration seam is the anti-pattern this invariant exists to prevent. If the failing test against the existing bug **passes** the first time you run it, the test is in the wrong place — pick a different level.
    - When unsure where the bug lives, write BOTH a unit test (for the class behaviour) AND an integration test (for the boundary). The unit test is fast insurance; the integration test is the regression lock for the actual failure mode. The 2026-05-14 damage-number incident is the canonical "got the level wrong on the first try" example: a unit test on `DamageNumberManager` passed easily, the user smoke-tested again, the bug was still there because it lived at `WorkerRendererClient ↔ worker` structured-clone, not in the manager.
    - State the reproduction recipe in the test docstring with the diagnostic dir-id and the exact symptom the user reported, in their own words where possible.
    - Use `harness.events.waitFor(...)` (integration) or `data-testid`-driven Playwright actions (E2E) so the test fails LOUDLY with a specific assertion, not a generic timeout.

    See `tests/integration/sectorRoom/DETERMINISM.md` for the integration-test recipe, `tests/e2e/drawer-galaxy-map-open-close.spec.ts` for the canonical "user reported, repro'd in test" pattern, and `tests/e2e/damage-number-lifetime.spec.ts` for the "boundary-crossing integration test via probe page" pattern.
14. **No new hot-loop allocation.** From this PR forward, any new code added inside a function called transitively from `update()` (server room tick), `tick()` (any system tick), `render()` / RAF callback, `handleSnapshot()`, `tickPhysics()`, or `onMessage()` must not allocate — no `new Set/Map/Array/Float32Array/...`, no `{}` / `[]` literals, no `.map/.filter/.slice/.concat`, no `Array.from`, no `JSON.parse/stringify` or `structuredClone`, no template literals building key strings. Reuse module-scope scratch, class fields, or the helpers in [src/core/pool/](src/core/pool/). For the "build a Set of seen IDs, then sweep cache" idiom, prefer the generation-counter pattern (`frameId++` stamps) over any pool. Existing pre-landed allocations are `// TODO: alloc-debt` and tolerated until backfilled; do not allow new ones. Full rationale, exemplars, and the code-review checklist live in [docs/architecture/memory-allocation-paradigm.md](docs/architecture/memory-allocation-paradigm.md). Lint enforcement is a deliberate follow-up PR, not this rule — until then, this is a code-review contract.

---

## Event Bus Architecture (read before adding any signalling)

EQX Peri uses **two distinct channels**, never blended:

- **Discrete event bus** (`eventemitter3`, wrapped in `src/core/events/Bus.ts`) — instantaneous low-frequency events only: spawn/despawn, fire, destroy, sleep/wake, TiDi rate change, transit state transition. Subscribers: Howler, Zustand, Pino, persistence.
- **Continuous state polling** — per-frame spatial data (positions, velocities, rotations) is read directly from the render state mirror / SAB. **Never** emitted as events.

Rules:

- Bus event shapes live as a single discriminated union in `src/core/events/Bus.ts`. No stringly-typed emits.
- Adding a continuous-data event is a code-review rejection.
- The renderer never subscribes to the bus for positions. Lint-enforced inside `src/client/render/`.
- The bus is per-process. Cross-process propagation happens over a wire (Colyseus, SAB, postMessage) and is re-emitted onto the receiver's local bus.

---

## Performance Budgets

| Surface | Budget | Notes |
|---|---|---|
| Physics tick (server + client `predWorld`) | 16.67 ms (60 Hz) | Fixed timestep (invariant #4); variable-dt is forbidden |
| Drawer click → visible | ≤ 500 ms | Current floor 1.22 s; see `docs/LESSONS.md` 2026-05-13 "Drawer perf paradigm + MUI sx-hoist rules" |
| Inline `sx={{...}}` allocation | Avoid per-render | Hoist static sx to module-level const; `useMemo` for dynamic; see [src/client/layout/Drawer/AdvancedDrawer.tsx](src/client/layout/Drawer/AdvancedDrawer.tsx) |
| GC pauses | < 2 ms | Captured via `diag/drawer-lag-trace/cdp-perf.json` + `scripts/analyze-cdp-profile.mjs` |
| SectorRoom `update()` per-tick | Per the budgets in [src/server/CLAUDE.md](src/server/CLAUDE.md) (interest grid, lag-comp buffer, backpressure) | |

---

## Technology Stack Matrix

| Zone | Allowed runtime libs | Purpose |
|---|---|---|
| Root tooling | `typescript`, `vite`, `tsx`, `pnpm`, `vitest`, `@vitest/coverage-v8`, `@playwright/test`, `eslint` + `eslint-plugin-import`, `prettier`, `dependency-cruiser`, `knip` | Build, test, lint, coverage, boundary-DAG + dead-code audit (refactor engagement — see `MANIFEST_APPARATUS.md`) |
| `src/core/` | `@dimforge/rapier2d-compat`, `eventemitter3`, `zod` (types), `poly-decomp` (convex decomposition for ship hulls), TS stdlib. No DOM, no Node-only APIs (except `worker_threads` behind a contract). | Physics, event bus, pure logic, DI contracts |
| `src/server/` | `colyseus`, `@colyseus/schema`, `@colyseus/ws-transport`, `express`, `zod`, `better-sqlite3`, `pino` + `pino-pretty` + `pino-roll` (rolling-NDJSON gameplay audit log — see `docs/architecture/gameplay-audit-log.md`). Optional Phase 9 (multi-VM only): `@colyseus/redis-driver`, `@colyseus/redis-presence`. | Authoritative simulation host, persistence, lag comp, backpressure, orchestration |
| `src/client/` | `colyseus.js`, `react`, `react-dom`, `@mui/material`, `@mui/icons-material`, `@emotion/*`, `pixi.js` v8, `pixi-viewport`, `howler`, `zustand`, `nipplejs` | UI, rendering, audio, input, client prediction |
| `src/shared-types/` | Pure TS + zod schemas only | Cross-zone contracts (message shapes, SAB layout constants) |

---

## SOLID Adherence (project-specific bindings)

- **S — Single Responsibility.** Each zone has one concern; each module has one axis of change. `PixiRenderer` never handles input. `Reconciler` never touches rendering. `SectorRoom` never formats Pino lines directly.
- **O — Open/Closed.** New weapons / AI / sectors are added by implementing existing contracts (`IWeapon`, `IAiBehaviour`, `ISectorDefinition`), not by editing switch statements.
- **L — Liskov Substitution.** Any `IRenderer` (e.g., a headless test one) is drop-in for the Pixi one. Any `INetworkSink` (e.g., a loopback one) is drop-in for the Colyseus one.
- **I — Interface Segregation.** Contracts are narrow: `IRenderer`, `IAudio`, `INetworkSink` are separate, never merged.
- **D — Dependency Inversion.** `src/core` declares abstractions; server and client supply concretions via constructor injection at bootstrap. Dependency direction goes *into* core, never out — enforced by ESLint `no-restricted-imports`.

---

## Repo Map

- `src/core/` — zone-pure simulation. Read `src/core/CLAUDE.md`.
- `src/server/` — Node + Colyseus authority. Read `src/server/CLAUDE.md`.
- `src/client/` — Browser UI + rendering. Read `src/client/CLAUDE.md`.
- `src/shared-types/` — wire contracts.
- `tests/e2e/` — Playwright multi-browser scenarios.
- `benchmarks/` — vitest-bench suites.
- `docs/LESSONS.md` — chronological log of non-obvious findings.
- `.github/workflows/ci.yml` — the enforcement pipeline.
- `eslint.config.js` — boundary rules. Treat modifications here with great care; weakening a pattern is equivalent to weakening invariant #1.

---

## Phase-Gate Ritual

At each phase's acceptance gate:

1. **Update the relevant CLAUDE.md** for any zone whose rules, contracts, or thresholds changed.
2. **Append to `docs/LESSONS.md`** if this phase surfaced a gotcha, benchmark surprise, or failure mode.
3. **Review Cross-Phase Invariants** — if one was added or amended, update this file.

Phase 0 seeds all CLAUDE.md files; every subsequent phase amends them.

---

## Commit cadence — commit at every passing milestone, not at session end

Long uncommitted sessions are a recovery hazard. If Vite HMR cycles go wrong, the laptop sleeps and wakes with a broken shell wrapper, or a long task hangs and the session has to bail — **every minute since the last commit is at risk**. Reconstructing "what belongs in which commit" from a sprawling working tree afterwards is far harder than committing each piece when it shipped. (2026-05-10: a multi-hour session ran galaxy-map refactor → AI plumbing → ship labels → error overlay end-to-end without a single commit. Don't repeat that.)

**The rule**: commit after every implementation milestone where the inner loop (`pnpm typecheck && pnpm lint && pnpm test`) is green AND the change forms a coherent unit. That usually maps to a step within a multi-step plan — *Step 1 wiring, Step 2 patrol, ...* — commit each separately, even when later steps are still pending.

**Do**:
- Commit each step when the inner loop is green. Imperative subject + plan reference: `feat(ai): hostility plumbing (Step 1, plan: <name>)`.
- Group only related changes per commit. If you find yourself touching three unrelated zones in one step, that's a smell — split.
- Before stopping a session: `git status` clean OR you have intentionally-noted pending work. If neither holds, that is a process bug — flag it before logging off.

**Don't**:
- Wait until "the whole plan is done" to commit. If a plan has five steps, the working tree should reach `git status` clean five times along the way (modulo small bridge edits).
- Bundle unrelated work because it happened in the same session.
- Commit yellow code "to save progress" — fix the test or revert before committing. `--no-verify` is forbidden by default (root CLAUDE.md, "Committing changes with git").

**Default behaviour for AI assistants in this repo**: when a step ships green, prompt the user with the proposed commit (subject + summary) and offer to run `git add -p` / `git commit`. Don't commit without explicit consent (per the "only commit when explicitly asked" rule), but don't silently let the diff sprawl either — surface the commit moment.

---

## Pushing branches & opening PRs — `gh` IS installed (2026-06-16)

`gh` (GitHub CLI, v2.94+) is installed (winget `GitHub.cli`, user scope at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_*\bin\gh.exe`, on the user PATH for new shells) and authenticated via `%APPDATA%\GitHub CLI\hosts.yml`. **Stop saying "gh isn't installed / branches are local" — it is.** Push + open a PR is a one-liner; **never leave finished, green work unpushed waiting to "ask" — when the user says push/PR (or the task implies shipping), do it.**

**`gh` is FULLY authed** — `read:org` was added 2026-06-16 (`gh auth refresh`), so `gh pr create / edit / list / view / checks / diff` ALL work natively:

```
git push -u origin <branch>
gh pr create --base main --head <branch> --title "…" --body-file diag/_pr-body-<x>.md
gh pr checks <n>   # CI status; gh pr view/edit/list/diff also fine
```

Fallback (only if gh's token rotates / loses scope): the REST scripts via git's GCM credential — `diag/adb-shots/_create-*.mjs` (`POST /repos/JanusBifrons/eqx-net/pulls`) + `_edit-pr<n>.mjs` (`PATCH /…/pulls/<n>`); token = `printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p'` → `Authorization: Bearer`. These need only `repo`, so they work even without read:org. (History: before the refresh, gh's GraphQL commands — list/edit/status/create — failed with `requires read:org`; the REST scripts were the workaround.)

Other notes:
- A fresh shell hasn't reloaded PATH → call gh by full path once, or in-PowerShell `$env:Path += ";$env:LOCALAPPDATA\Microsoft\WinGet\Packages\..."`.
- If gh auth ever breaks (token rotated), re-add the scope with `gh auth refresh -h github.com -s read:org` — run it in **PowerShell / Windows Terminal** (a real PTY), NOT Git Bash/MinTTY (which errors `could not prompt: Incorrect function`); in Git Bash, prefix with `winpty`. Or re-mint hosts.yml directly: `printf 'github.com:\n    oauth_token: %s\n    user: JanusBifrons\n    git_protocol: https\n' "$TOKEN" > "$APPDATA/GitHub CLI/hosts.yml"` (`$TOKEN` from `git credential fill`).

---

## Verification Protocol (apply after every server-touching change)

After any change to `src/server/` or its config, **boot the server before reporting success**:

```
timeout 8 pnpm dev:server
```

A clean boot prints `INFO: EQX Peri server started port: 2567` with no uncaught exceptions. A crash (exit code non-143) means the change broke the runtime even if typecheck passes — fix it before moving on. Exit code 143 is normal (SIGTERM from `timeout`).

This exists because TypeScript's type system cannot catch runtime issues like decorator transform mismatches, missing `Symbol.metadata`, or ESM resolution failures that only surface at Node.js startup.

If port 2567 is already taken, **kill the existing process and reclaim it** — see the next section. Don't dodge onto `PORT=2568`; that just leaves zombies behind.

---

## Stale dev servers cause "phantom" E2E failures — Claude owns the servers, kill before starting

`playwright.config.ts` sets `reuseExistingServer: true` for both `pnpm dev:server` (port 2567) and `pnpm dev:client` (port 5173). That's convenient for the live-dev loop, but it has a sharp edge:

- If a server from a **previous session** is still listening on either port, Playwright will reuse it instead of spawning a fresh one.
- A stale Colyseus server is running pre-edit code, so its SAB layout, schema, and message shapes won't match the freshly-built client.
- A stale Vite dev server may have HMR'd into an inconsistent state after files were edited externally — the client either won't render the splash or will throw on init.

The classic symptom is a flood of timeouts starting from `boot.spec.ts` ("heading not found"), which is a client-only test that should be impossible to fail unless Vite is broken.

**Policy: Claude is in full control of dev servers in this repo.** The user runs sessions via phone-based remote control and does not keep a hand-curated dev server in a side terminal — anything `LISTENING` on 2567 or 5173 was started by Claude (or a previous Claude session) and is safe to reclaim. **Kill the existing process and boot a fresh one on the canonical port** rather than dodging onto an alternate port like `PORT=2568` (which just leaves zombies behind).

**Before any server boot or E2E run:**

```powershell
netstat -ano | findstr ":2567 :5173" | findstr LISTENING
# For each PID returned:
Stop-Process -Id <pid> -Force
```

Then run `timeout 8 pnpm dev:server` (boot smoke) or `pnpm e2e` normally. For diagnostic E2E runs, set `$env:CI='1'` so Playwright always spawns a fresh server — but if a stale one is already in the way, kill it first.

Do not change `reuseExistingServer` to `false` casually — that breaks the live-dev loop for both sides. The right pattern is: kill, then boot, then run.

---

## Running E2E Tests

Playwright runs are slow (a single spec can take 30–120 s; the full suite is multi-minute). The original concern was that a synchronous `pnpm e2e` call would appear to "stall" the harness — that's still true if you run the *whole suite* in foreground, but targeted runs are fine and you have permission to do them.

> **Measurement specs live in `tests/perf/`, never in `pnpm e2e`.** Fixed-window heap/allocation/bandwidth/worker-A-B specs that hold a wall-clock window to gather a number (and are inherently host-load-variance-prone) run **only** via `pnpm e2e:perf` (`playwright.perf.config.ts`, 150 s per-test cap) — they are NOT part of the per-PR `pnpm e2e` regression suite. Adding a spec that waits out a fixed window for a measurement? It belongs in `tests/perf/`, not `tests/e2e/`. See `docs/refactors/test-coverage-audit.md` + the Determinism-refactor section of `docs/architecture/e2e-framework.md`.

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

---

## Netcode-health gate (`pnpm e2e:netgate`) — required for live-loop-touching changes

The Phase-1 deliverable of the e2e-rebuild plan (`C:\Users\alecv\.claude\plans\i-want-you-to-lively-tulip.md`). The deterministic suite (typecheck + lint + unit + integration + bench) verifies logic in isolation; it is **not** a playability signal. The 2026-05-19 wrap-up shipped with every deterministic gate green and was unplayable on-device — `docs/LESSONS.md` 2026-05-19/20 has the full incident. The netgate is the live-loop check the deterministic suite was never trying to be: it joins a real Colyseus room over an injected mobile-network profile and compares the `data-pred-stats` HEAD writes against a same-session baseline arm on the same box.

**Scenarios — it gates HEALTH, never correctness (multi-scenario, plan: misty-teapot).** The catalogue is `tests/netgate/scenarios.ts` (`SCENARIOS[]`, the single source of truth for BOTH the spec and CI selection). `core` (`feel-test-25`, 25 drones, gated) is the foundational local-feel check. `structures-load` + `scrap-load` are **print-only** perf scenarios (heavy structure-grid / scrap-burst workloads). Load-bearing distinction: every gated metric measures the **LOCAL PLAYER's prediction reconciliation**, so the netgate CANNOT detect a structures/scrap *correctness* regression (a wrong scrap `componentIndex`, a corrupted `structures[]` encode) — those move no local metric and the lossless in-order proxy never drops a late/bloated payload. **Correctness for those wire surfaces is gated DETERMINISTICALLY** (`BinarySwarmBroadcast`/`BinarySwarmDecoder` tests, `tests/unit/swarmWireRoundTrip.test.ts`, `scrapOnDeath`/`structureScenario`/`structureGrid` integration). The perf scenarios instead gate whether a heavy structures/scrap workload degrades the local player's feel via the server tick/broadcast budget — and they stay print-only until a **server-side tick-burn fault-injection** proves their metrics actually move under that load (the network-inject self-test cannot prove this; that's the promotion bar). Galaxy is deliberately out (client-render path, covered by deterministic E2E).

**When required (invariant #8 corollary).** Any PR matching a scenario's `triggerGlobs` in `scenarios.ts` — `core`'s set is SHARED live-loop (`src/client/net/`, `src/core/prediction|physics/`, `WeaponMountController`, `SectorRoom`/`SnapshotBroadcaster`/`EntitySyncRouter`, `swarmWireFormat`, `messages/`) **∪ STRUCTURE** (`src/server/structures/`, `src/core/structures/`, `structureKinds.ts`) **∪ SCRAP** (`ScrapSpawner.ts`, `scrapCollider.ts`, `scrapConstants.ts`). The structure/scrap server paths were a **false-negative hole** in the old hand-maintained regex (a pure structures/scrap logic change SKIPPED the gate); they now correctly fire `core`. CI does the selection itself (`tests/netgate/select-scenarios.mjs`, **fail-closed**: an error / empty / API-truncated / unenumerated-live-loop-path diff runs ALL gated scenarios; only a provably non-live-loop diff skips). You don't predict from `git diff` — the gate's pass/fail IS the verdict.

**How to run.**

- `pnpm e2e:netgate` — defaults: scenarios `core`, baseline `origin/main`, head = working tree, primary mobile profile (≈120 ms RTT ±60 ms, 0 % drop), 4 interleaved reps `A/B/A/B/A/B/A/B`. `NETGATE_SCENARIOS=core,structures-load,scrap-load pnpm e2e:netgate` runs the matrix (each scenario is its own Playwright `test()`); the netgate `workflow_dispatch` has a `scenarios` input for characterising a print-only scenario on CI hardware.
- The driver (`tests/netgate/run-netgate.ts`) creates two git worktrees under `.claude/worktrees/netgate-{baseline,head}` (incremental — preserves `node_modules` across runs), boots two `vite` dev servers with HMR disabled on both, starts a per-arm HTTP+WS latency proxy, and runs `tests/e2e/netcode-health.spec.ts` interleaved on each. ~6–8 min for a single-scenario acceptance run.
- **The gate's pass/fail IS the verdict.** Do NOT predict from `git diff`. "Those commits don't touch netcode so it's probably fine" is the falsified cop-out class the user's memory specifically flags — the gate exists so we never make that prediction. Read the metric + magnitude, report it. If RED, `git bisect run pnpm e2e:netgate` narrows it.

**What it gates (single source of truth: `tests/netgate/netHealthBudget.ts`).** `rollingCorrRate`, `ticksAhead`, `maxDriftUnits`, `meanDriftUnits`, `droppedSnapshotsRecent` — each metric uses a **relative AND absolute** AND-gate (head must be both worse than baseline by margin AND past the documented playable ceiling to fail). Improvements (ratio ≤ 1) can never fail. Liveness preconditions (`snapshotCount > 40`, `diagEnabled === false`) are a DISTINCT result channel — "the gate did not validly run" must never read as "healthy."

**Print-only (NOT gated).** `snapshotJitterMs` and `rtt*` are proxy-jitter-dominated — their baseline variance over identical-code reps (19.5–130.8 ms for jitter; 6.7× spread) exceeds any sensible margin. Same disqualifier the plan used to exclude `rtt*` at the outset. Re-adding either without solving the injected-jitter confound is a deliberate, reviewed change.

**Don'ts.**

- **Don't add it to the inner loop.** Multi-minute + worktree-creating. The deterministic suite stays the inner loop; the netgate is a conditional outer gate.
- **Don't measure the gate with `?diag=1`.** Phase-0a's `?diag=0` URL override + `__resetDiagCache()` is the entire reason the gate measures the production code path (Playwright sets `navigator.webdriver=true` which auto-enables diag; without the override every spec measures an instrumented build no player ever runs). The spec asserts `__eqxDiagEnabled === false` before reading stats.
- **Don't widen a margin to silence a flake.** If it flakes, characterise the variance with `main`-vs-`main` ≥ 3× and either fix the *metric set* (demote → print-only, like `snapshotJitterMs`) or fix the *mechanism*, not the threshold. The whole anti-flake architecture is mechanism not margin.
- **Don't bypass the measurement-harness overlay.** The driver copies the working tree's `ClientLogger.ts` + `vite.config.ts` onto every worktree before booting its dev server — the measurement harness must be uniform across arms; each ref keeps its own netcode. Booting a pre-Phase-0a ref naïvely makes the diff a harness mismatch, not a netcode delta.

**Auto-retry ONCE, then BELIEVE it (policy 2026-06-15 — corrects the earlier "never retry" purism).** The netgate is a relative measurement and is variance-prone on contended hosted runners; empirically every recurring RED cleared on a fresh-runner re-run, so the "never retry, only characterise" stance was bad advice in practice. The separate **`auto-retry.yml`** workflow (`workflow_run`-triggered) **auto-re-runs a failed CI/Netgate run's failed jobs exactly once on a fresh runner** (`run_attempt == 1` guard — `rerun-failed-jobs`). It MUST be a separate workflow: `rerun-failed-jobs` is rejected (HTTP 403 "workflow is already running") if called from a job INSIDE the still-running run, and `workflow_run` only fires from the default branch (so it takes effect once merged to main). This is NOT retry-until-green: a failure that **survives the retry (attempt ≥ 2) is LEGITIMATE.** Treat it as a real regression — **investigate the netcode; do NOT report it as a "host flake" or "the box."** Deflecting a surviving failure to the host is the exact reflex this policy exists to stop. Widening a margin to silence a flake is still forbidden (mechanism, not margin). When a surviving RED really is environmental, the fix is a *mechanism* one (a quieter/self-hosted runner, a baseline-sanity liveness precondition), surfaced as such — never a shrug.

---

## Test-harness philosophy — bespoke gameplay triggers, never bump timeouts

E2E tests must be **highly controlled and tightly scoped**. Target: a single test runs in **1-2 seconds wall-clock** wherever the game logic allows it. When a test needs longer, the right move is almost always to **add a bespoke gameplay trigger** that bypasses the wait, NOT to expand the timeout. Bumping the budget hides the real signal ("the game-time wait is too long to belong in a test"), invites flakes, and bloats the suite wall-clock under the next gameplay-tuning change.

**The proof:** the 2026-05-17 slow-down-gameplay PR (+50 % shield + hull, 10× warp spool) silently broke every combat smoke spec that assumed pre-tuning TTK. The wrong fix was bumping timeouts (15 s → 30 s → 45 s); the right fix was the `initialHull=1` / `initialShield=0` server-side override that makes a 1-tick kill test possible. The bump-pattern would have broken again on the NEXT tuning pass; the bespoke trigger is invariant under future combat-tuning changes.

**Triage when a test needs > 30 s default:**

1. *What gameplay state am I waiting for?*
2. **Infrastructural cost** (page navigation, browser cold-boot, Colyseus join + first snapshot, Vite cold-compile) — a budget bump is reasonable. These aren't under test control.
3. **Game-time cost** (TTK, projectile travel, shield regen, warp spool, respawn delay, ghost TTL, snapshot cadence convergence) — **find or add a bespoke trigger.** If none exists, add one; the new primitive will pay for itself within 2-3 tests.

**Existing bespoke primitives** (catalogue + when to reach for them):

| Primitive | Purpose | Where | Caveat |
|---|---|---|---|
| `initialHull: number` | Override spawn HP. `1` = one-tick-kill. | `JoinOption`, testMode-only. `tests/e2e/helpers/gameScenario.ts:TestClientOpts.initialHull` | `data-hull-pct` is a percent against `maxHealth` (~750 post-slow-down), so `initialHull=1` rounds to 0 % at spawn — use `10` (~1 %) when the test needs hull-pct > 0 at spawn. |
| `initialShield: number` | Override spawn shield. `0` = first beam hit lands hull. | Same as above. | None — shield is transient. |
| `testTimeScale: number` | Multiplies physics-tick dt. The `test-sector-fast` room ticks 10×. Ghost TTL (500 ms) → 50 ms wall-clock; projectile lifetime (4 s) → 400 ms; warp spool (30 s) → 3 s. | Room option (`src/server/index.ts` definition). | `state.clockRate` stays unmultiplied (audio + TiDi UI unaffected). Only physics speeds up; network cadence (20 Hz) and broadcasts stay at real-time. |
| `testId: string` + `filterBy(['testId'])` | Per-test room isolation. Each unique testId routes to its own room. Multi-client tests share an explicit testId. | `JoinOption` (clients) + `filterBy` on the room definition (`src/server/index.ts:test-sector` + `test-sector-fast`). | Use `randomUUID()` at the test level; pass to every `launchTestClient` / `joinClientAt`. Tests that don't pass a testId share a default room (back-compat). |
| `dronePoses: [{kind, x, y, angle?, hullExposed?}]` | Deterministic drone placement at hand-authored world poses, bypassing the uniform-disc spawner. `hullExposed: true` drops shields at spawn so the polygon collider is active immediately. Used by `hull-collision-test` + `hull-collision-overlap-test` rooms. | `roomOpts` field in `SectorRoom` (testMode-gated). `src/server/rooms/SectorRoom.ts` `useDronePoses` branch. | Static-overlap collision detection via `data-pred-stats.collisionEventsApplied` does NOT work for drone-vs-drone (client predWorld keys are `swarm-${entityId}`, not the server's drone IDs). Use server-side `/dev/events` (filter by `tag === 'collision_resolved' \|\| 'ram_damage'` and the pair's `aId`/`bId`). See `tests/e2e/t-ship-no-self-collision.spec.ts`. |
| `startHostile: boolean` | Pre-mark every drone in the sector hostile to the joining player at spawn — first frame is steady-state combat, no IDLE→COMBAT transition. Mirrors LivingWorldBotHooks `markBotHostile` (per-drone `aiController.markHostile` + `bot_aggro` broadcast). | `JoinOption`, testMode-only. URL pass-through `?startHostile=1` in `src/client/app/gameSurfaceBootstrap.ts`. Wired post-spawn in `src/server/rooms/SectorRoom.ts` onJoin. | Used by `tests/e2e/combat-allocation-profile-hostile.spec.ts` (plan: imperative-taco) for a clean CDP allocation-profile window. Ignored on galaxy rooms — a wire-level safeguard against malicious force-aggro. |
| `lingerMs: number` | Override the per-player disconnect-linger TTL (ms). Lets the linger E2E observe the despawn→return-to-pool transition in ~2 s instead of the 15-min `LIMBO_DISCONNECT_TTL_MS` window. | `JoinOption`, testMode-only. URL pass-through `?lingerMs=` in `gameSurfaceBootstrap.ts`; captured per-player in `SectorRoom.onJoin` (`playerToLingerMs`), threaded into `LeaveHandler` for both the Limbo window AND the ownerless-evict timer; cleared on leave. | Galaxy-only (lingering requires `sectorKey !== null`); use the `galaxy-test` room. Drives `tests/e2e/linger/*` + `tests/integration/sectorRoom/lingerDespawnReturnsToPool.test.ts`. |
| `auto-fire-test` room | Peaceful, hull-exposed `fighter` drone parked 150 u ahead of spawn (within beam range 250). Join `?room=auto-fire-test&startHostile=1` → the drone is flagged hostile so the client auto-fires at it with NO input; omit `startHostile` to assert auto-fire does NOT engage a neutral drone. `testTimeScale:10`. The bespoke primitive for auto-fire E2Es — `test-sector-fast` has no drones and `dronePoses` is not a URL param, so a dedicated room is required. | `gameServer.define('auto-fire-test', ...).filterBy(['testId'])` in `src/server/index.ts`. | Pair with a high `?initialHull` if the drone is non-peaceful; the default room keeps it peaceful so the player survives. Drives `tests/e2e/auto-fire.spec.ts`. |
| `galaxy-test` room | Isolated, bot-free, **linger-capable** room (real `sectorKey`, so the galaxy-only linger + abandon-poll paths fire; engineering rooms with `sectorKey===null` never linger). `droneCount:0` + `asteroidConfig:[]` → deterministic scene for screenshots; excluded from `GALAXY_SECTORS`/eager-create so the `LivingWorldDirector` routes no hunter bots. | `gameServer.define('galaxy-test', ...).filterBy(['testId'])` in `src/server/index.ts`. Reach it via `launchGalaxyTestClient` (`?room=galaxy-test&worker=0`). | Owners never see their OWN displaced lingering hull (it's rescued into `mirror.ships`), so lingering-visibility assertions need a 2nd observer client. Use `?worker=0` for screenshot-able rendering (the default OffscreenCanvas-in-worker path screenshots black). |
| `structureGridPulseMs: number` | Override the structure grid pulse interval (ms). The grid pulse (construction / mining / transfer) is a **wall-clock timer, NOT the physics tick**, so `testTimeScale` can't speed it — this is the bespoke trigger that fast-forwards construction + mining for E2E. | `JoinOption`, testMode-only. URL pass-through `?structureGridPulseMs=` in `gameSurfaceBootstrap.ts`; reaches `onCreate` on the room-creating client. Default `TRANSFER_PULSE_MS` (1000). | Min 20 ms. Turret fire stays on the fixed `TURRET_TICK_MS` (100 ms) cadence — this only scales the logistics pulse. |
| `prebuiltStructures` / `scenarioDrones` / `scenarioAsteroids` (room opts) + the `structure-scenario-test` room | Seed a PRE-BUILT, auto-connected, **powered** grid + parked drones + asteroids, owner `scenario`. The bespoke primitive for structure E2Es: the place-ahead Build UI stacks multiple placements at one spot (overlap → rejected), so a multi-structure grid can't be built via the UI — and construction takes seconds. This seeds the end state directly. | Room-definition opts read in `SectorRoom.onCreate` (`seedStructureScenario`, testMode-gated). The `structure-scenario-test` room (`src/server/index.ts`) bakes Capital+2 Solar+Miner@asteroid+Turret@drone. `_internals.{spawnTestAsteroid,spawnTestDrone,tickStructureTurrets,pulseStructureGrid}` are the integration seams. | Capital `maxConnections` is 4 — keep ≤ 4 leaves per capital. Place leaves on distinct axes (collinear leaves block each other's line-of-sight connection). Drives `tests/e2e/structure-scenario.spec.ts` + `tests/integration/sectorRoom/structureScenario.test.ts`. |

**Adding a new primitive** (when 3+ tests would benefit from the same skip):

1. Define the JoinOption (zod schema, testMode-gated) in `SectorRoom.JoinOptionsSchema`.
2. Apply it in `onJoin` (after kind-default initialisation, before persistence write).
3. Wire URL → joinOption in `App.tsx`'s URL-param pass-through block (`if (urlParams.has('myFlag')) extraJoinOptions['myFlag'] = ...`).
4. Surface in `TestClientOpts` in `tests/e2e/helpers/gameScenario.ts`.
5. Document in `docs/architecture/e2e-framework.md` "Bespoke gameplay triggers" section.

**Anti-patterns to reject in code review:**

- `test.setTimeout(N_MUCH_LARGER)` without a corresponding game-time trigger added — bumping the test budget to "fix" a TTK problem is hiding the defect, not solving it.
- `await page.waitForTimeout(N)` to pace past a game-time wait — use `waitForFunction(state predicate)` with the same N as a *deadline*, while triggering the state through a bespoke flag instead of pacing.
- Hardcoded `expect(duration).toBeLessThan(N)` that assumes pre-tuning TTK / cooldown — express expectations against the gameplay state being tested, not the wall-clock to reach it.
- Tests that only fail when a recent gameplay-tuning PR landed — that's not a test infrastructure problem, it's a test-design defect that the framework should surface and fix at the source.

**Vanity stat from 2026-05-20 (the philosophy pays off):** smoke suite 31 pass / 19 fail / 15 min → 41 pass / 3 fail / 6 skipped / 8.3 min — same 50 tests, sequentially, on the same box, via per-test repair work that mostly meant "add the right primitive" rather than "bump the timeout."
