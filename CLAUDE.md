# CLAUDE.md — EQX Peri (Root)

You are working in **EQX Peri**, a multiplayer space game. Read this before any non-trivial change. Zone rules load when you touch a file in the zone: [src/core/CLAUDE.md](src/core/CLAUDE.md), [src/server/CLAUDE.md](src/server/CLAUDE.md), [src/client/CLAUDE.md](src/client/CLAUDE.md).

**What goes where.** CLAUDE.md files hold **rules only**: short, present tense, no dates, no PR numbers, no history. How a subsystem works, thresholds and tuning values, and history go in the matching guide under `docs/architecture/` or `docs/features/` (history in the guide's "History" section), with a one-line pointer from CLAUDE.md. Gotchas go in [docs/LESSONS.md](docs/LESSONS.md). Every CLAUDE.md is injected into every agent's context, so each line here costs on every call.

The Master Architecture Blueprint is the authoritative design document; the approved plan under `C:\Users\alecv\.claude\plans\` is the roadmap. When the blueprint and a zone CLAUDE.md disagree, the most recently updated CLAUDE.md wins.

---

## Cross-Phase Invariants (ALL must hold at every phase gate)

1. **Boundary integrity.** `src/core` imports no client or server library. `src/server` imports no client library. `src/client` imports no server-only package or Node-only API. CI-enforced by `eslint-plugin-import` `no-restricted-imports` and `dependency-cruiser` (`.dependency-cruiser.cjs`; the `verify` job runs `depcruise src`). The canary [src/core/\_\_fixtures\_\_/leak.ts.disabled](src/core/__fixtures__/leak.ts.disabled) proves enforcement is live: toggling its extension must break both checks.
2. **Zustand purity.** No spatial field (`x`, `y`, `vx`, `vy`, `angle`, `rotation`, `position`, `velocity`, nor suffixed `*X`/`*Y` coordinates) in the Zustand store; the lint rule in `eslint.config.js` blocks it. The few discrete keys allowlisted by name each carry a justification; a new coordinate key must argue its way onto that list, never be named around the lint. Lock: `tests/unit/zustandPurityLint.test.ts`. Spatial state lives in the render mirror polled by Pixi.
3. **Network validation.** Every inbound server message has a zod schema. Malformed packets are dropped with a sampled `pino.warn`; they never reach game logic.
4. **Fixed timestep.** `world.step(1/60)` inside a `while (accumulator >= fixedDt)` catch-up loop. No variable-dt physics anywhere.
5. **DI seams.** `src/core` never constructs a renderer / audio / network sink / persistence. Zones inject implementations at bootstrap via the contracts in `src/core/contracts/`.
6. **SOLID adherence** (see below). Enforced at code review.
7. **Docs currency.** A PR that changes an invariant, adds a contract, introduces a threshold or teaches a non-obvious lesson updates the docs in the same PR: a rule → the zone CLAUDE.md (≤ 3 lines, per "What goes where"); a threshold, tuning value or how-it-works text → the matching `docs/architecture/` guide; a gotcha → `docs/LESSONS.md`. About to merge without touching any of them? Stop and ask whether the PR is teaching something.
8. **Green bars before done.** `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e && pnpm bench` all pass. A change touching the live loop (client `net/`, `prediction/`, physics, render loop, snapshot decode/interpolate, mount aim, `SectorRoom` tick/snapshot) also needs `pnpm e2e:netgate` baseline-relative green: the deterministic suite verifies logic, not playability.
9. **Tests accompany every behavioural change.** A PR that changes physics, prediction, obstacle sync or collision handling includes a new or updated E2E test in `tests/e2e/` that would have caught the regression. "I manually verified it" is not sufficient; without the test the PR is incomplete.
10. **Documentation as a shipped artefact.** Every major feature ships with a prose guide under `docs/features/` (player-facing) or `docs/architecture/` (internals): the why, the migration path, the future plans. Examples: `galaxy-graph.md`, `persistence-and-migrations.md`, `ship-physics-handling.md`.
11. **Ship- and structure-kind catalogues are append-only.** [src/shared-types/shipKinds.ts](src/shared-types/shipKinds.ts) is the single source of ship types; `SHIP_KINDS_LIST` order is part of the swarm wire format (u8 index). Append a record; removing or reordering bumps `SWARM_WIRE_VERSION`, and the decoder must hard-fail the old version. The same binds [src/shared-types/structureKinds.ts](src/shared-types/structureKinds.ts) (`STRUCTURE_KINDS_LIST` order rides the shared `shipKind` byte when the pose-core `kind` is 2). Bump `STRUCTURE_KIND_CATALOGUE_VERSION` only when an EXISTING record changes: a bump discards every saved structure; an appended kind does not. Geometry of composite-ship scrap and capital wreck pieces is derived client-side by shared deterministic code, never sent on the wire. Detail: [ship-kinds](docs/features/ship-kinds.md), [structures](docs/architecture/structures-and-power-grid.md), [composite ships + scrap](docs/architecture/composite-ships-and-scrap.md), [capital destruction](docs/architecture/capital-destruction.md).
12. **One owner per moving-entity state.**
    - **Mount angles:** `WeaponMountController.tickSlot` (with its `pickTarget` / `rotateMountToward` primitives) is the only writer of per-mount angles; the server's player and drone updates and the client's local-player prediction call it. A player's mounts aim only at their weapon group's lock target (locked, else the one being acquired; none ⇒ home): server `WeaponMountTicker.tickPlayer`, client `ColyseusClient.fcTickMountAngles` (the one client mount-angle path).
    - **Drones have no client AI:** drone mount angles come from `SnapshotMessage.drones[].mountAngles` (a slim `{ id, mountAngles?, shieldDown? }` slice); drone, scrap and wreck pose flows only on the binary swarm wire and is DRAWN only by snapshot interpolation (`interpolateSwarmPose`). `POSE_RING_DEPTH` must cover `DISPLAY_DELAY_MS` at the in-interest binary cadence (~1000/60 ms), not the 50 ms JSON rate.
    - **Collision bodies:** every remote moving entity has one path. Each snapshot, `preResetRemoteShips` resets remote ships to `snap.states` and drones/scrap/wrecks to their authoritative state at `snap.serverTick` (`anchorRemoteSwarmBodies`); reconcile replay and `tickPhysics` then move them forward together. Nothing re-poses a body per frame; local beam and hit-prediction rays test drones/scrap at the drawn pose (`DisplayPoseHitscan`); the server stays hit-authoritative. Never add a second drone-specific collision path.
    - Detail: [weapon-mounts](docs/architecture/weapon-mounts.md), [drone-snapshot-interpolation](docs/architecture/drone-snapshot-interpolation.md).
13. **Smoke-test bug reports get a failing test BEFORE the fix.** Order is non-negotiable: (1) reproduce in an E2E or integration test that drives the reported flow and FAILS on current code; (2) fix; (3) commit test and fix together, so reverting the fix re-fails the test. Write the test at the level where the bug LIVES (crossing a worker / postMessage / structured-clone boundary if the bug is there), not where it is easiest; a test that passes first time is in the wrong place. When a bug survives a fix, the next attempt's failing test must be at a DIFFERENT level. Workflow (captures → steps, level choice, docstring recipe): [diagnostic-captures](docs/architecture/diagnostic-captures.md#from-a-smoke-test-report-to-a-failing-test).
14. **No new hot-loop allocation.** Code reached from `update()` (room tick), any `tick()`, `render()` / RAF, `handleSnapshot()`, `tickPhysics()` or `onMessage()` must not allocate: no `new Set/Map/Array/TypedArray`, no `{}` / `[]` literals, no `.map/.filter/.slice/.concat`, `Array.from`, `JSON.parse/stringify`, `structuredClone`, or template-literal keys. Reuse module scratch, class fields or [src/core/pool/](src/core/pool/); for seen-ID sweeps use a generation counter. Tag every knowingly tolerated allocation `// TODO: alloc-debt` (the tag is the accounting); never add new ones. Detail: [memory-allocation-paradigm](docs/architecture/memory-allocation-paradigm.md).
15. **Two-sided contracts change on both sides or not at all.** A value or behaviour on both sides of the wire (a visual band mirroring a damage band, a client guard mirroring a server guard, a collider with a predWorld twin, a muzzle offset) lives in shared code (`src/shared-types` / `src/core`) or ships with a test that FAILS when the sides disagree. Review every fix with: "what is the other side of this, and did we touch it?"
16. **Client-visible state is reconstructible from snapshot ∪ join payload.** Discrete events (`bot_aggro`, `warp_warning`, …) only speed things up; a late joiner or dropped packet must converge from snapshots alone. Client-visible state carried ONLY by an event is a review rejection. Template: the slim snapshot fields (`level`, `mounts`, `shieldDown`, `hp`), emit-when-non-default, no wire-version bump.
17. **Liveness predicates are enumerated, not improvised.** A ship is exactly one of ACTIVE / LINGERING / DEAD. Every loop over `state.ships` (or players) gates on a named shared predicate, never an ad-hoc mix of `ship.alive`, `ship.isActive` and map membership; a new per-ship loop states in a comment which classes it covers and why. **TRAVELLING:** an ACTIVE hull on a warp run (`ShipState.travelling`) is out of the world: world-facing loops (AI targets, damage, turrets, loot) skip it; pilot-only loops (energy, shield regen) keep running ([travel-state](docs/architecture/travel-state.md)). **ENGAGEABLE:** NPC fire control (NPC locks, drone and capital turret candidates, structure-turret pilot scans) engages a pilot through `isEngageablePilotHull` / `SectorRoom.engageablePilotHull`: their ACTIVE hull, or the LINGERING hull they parked by Spectate (spectating never dodges a fight).
18. **Size-dependent numbers come from `shipTuning`, never a constant.** Anything that follows ship size (muzzle clearance, hit radius, shield pad, turret/nozzle sizes, spawn clearance, loot pickup, flock spacing, AI standoff, bake pixels-per-unit) is read from `shipTuning(kind)` / `tuningFor(id)` in [src/shared-types/shipScale/](src/shared-types/shipScale/). A fixed `20` or `?? 16` is a bug. The shipping default is 2× B; catalogue numbers are authored at 1×; tests locking authored numbers use `describe.runIf(AT_AUTHORED_SHIP_SCALE)` (run locally: `pnpm test:authored-scale`). Locks: `shipScaleInvariants.test.ts`, `muzzleParity.test.ts`. Detail: [ship-scale](docs/architecture/ship-scale.md).
19. **No weapon fires without a completed lock on its target.** Every player is tracked by `LockSubsystem` from join; `PlayerFireResolver` refuses a group with no LOCKED target, and any mount whose barrel doesn't bear on it per the shared `mountBearsOn(weaponId, …)`, without spending cooldown or energy. NPC ships and structure turrets lock their targets too. No legacy pass-through. The client mirrors the gate in `fcFireTick` (#15). Lock claims are verified (`lock_track` against `lockLineScore`) and rate-limited. Tests not about locking use the `instantLock` trigger (plus `anyTarget` for AUTO on a neutral), `harness.lockTarget` or the E2E `lockOn` helper, never a bypass. Detail: [fire-control](docs/architecture/fire-control.md).
20. **Game time is the default; each sector has its own speed.** A sector runs at 0.25–4× (automatic load slowdown with a 0.7 floor via `LoadSpeedController`, or a forced speed via `SectorRoom.setTimeScale`). Everything measuring gameplay or presentation time follows it with no code of its own:
    - **Server:** the room's `gameClock` (`now()` / `.after` / `.every`); cross-sector work uses `gameNow()` / `gameSetTimeout` / `gameSetInterval` (`src/server/time/gameTime.ts`).
    - **Ticks:** the room loop and its physics world run 60 × speed fixed 1/60 s ticks per wall second (#4 holds).
    - **Client:** `ColyseusClient.gameClock` for tick math; `PixiRenderer.fxNow()` for every effect.
    - **Lint:** `Date.now` / `performance.now` / `setTimeout` / `setInterval` are errors in `src/core`, `src/server`, `src/client/render`, `src/client/effects` outside the named real-time allowlist in `eslint.config.js`; a one-off real-time line carries `-- real time: <why>`.
    - **Never** add a per-feature speed factor: code that needs the speed is reading the wrong clock. Detail: [game-time-scale](docs/architecture/game-time-scale.md).

---

## Event Bus Architecture (read before adding any signalling)

Two channels, never blended:

- **Discrete event bus** (`eventemitter3`, wrapped in `src/core/events/Bus.ts`): instantaneous low-frequency events only (spawn/despawn, fire, destroy, sleep/wake, TiDi rate change, transit transitions). Subscribers: Howler, Zustand, Pino, persistence.
- **Continuous state polling:** per-frame spatial data is read directly from the render state mirror / SAB, **never** emitted as events.

Rules: bus event shapes are one discriminated union in `Bus.ts` (no stringly-typed emits); a continuous-data event is a review rejection; the renderer never subscribes to the bus for positions (lint-enforced in `src/client/render/`); the bus is per-process, and cross-process signals arrive over a wire and are re-emitted on the receiver's bus.

---

## Performance Budgets

| Surface | Budget | Notes |
|---|---|---|
| Physics tick (server + client `predWorld`) | 16.67 ms (60 Hz) | Fixed timestep (#4) |
| Drawer click → visible | ≤ 500 ms | See `docs/LESSONS.md` "Drawer perf paradigm + MUI sx-hoist rules" |
| Inline `sx={{...}}` allocation | Avoid per-render | Hoist static sx to a module const; `useMemo` for dynamic |
| GC pauses | < 2 ms | `scripts/analyze-cdp-profile.mjs` |
| Structures at base scale | Every number in [src/shared-types/structureBudgets.ts](src/shared-types/structureBudgets.ts), each with its measurement | Raised only by a reviewed change citing a NEW measurement; never widened to get green. Ledger: [structure-network-scale](docs/architecture/structure-network-scale.md) |
| SectorRoom `update()` per tick | Per [src/server/CLAUDE.md](src/server/CLAUDE.md) | |
| Perf-scene COUNTS (every PR) | `src/shared-types/perf/perfBudgets.ts` (`COUNT_BUDGETS`, `CLIENT_COUNT_BUDGETS`) | Server: `perfSceneCounts.test.ts`; client: `pnpm perf:counts`. Budget = max of calibration runs + 25 %. See [perf-scenes](docs/architecture/perf-scenes.md) |

**Gate on counts, compare timings.** A per-PR test never asserts a wall-clock bound: count the work (calls, ticks, bytes, draw calls) or print the time and gate nothing. Timings are judged only by `pnpm perf:scenes` (same machine, interleaved A/B). A new count budget is calibrated locally AND on CI; one that differs materially between them stays print-only.

---

## Technology Stack Matrix

| Zone | Allowed runtime libs | Purpose |
|---|---|---|
| Root tooling | `typescript`, `vite`, `tsx`, `pnpm`, `vitest`, `@vitest/coverage-v8`, `@playwright/test`, `eslint` + `eslint-plugin-import`, `prettier`, `dependency-cruiser`, `knip`, `vite-plugin-pwa` + `@vite-pwa/assets-generator` | Build, test, lint, coverage, boundary DAG, dead code, PWA |
| `src/core/` | `@dimforge/rapier2d-compat`, `eventemitter3`, `zod` v4 (`z.record(enum, v)` is exhaustive; use `z.partialRecord` for subsets), `poly-decomp`, TS stdlib. No DOM, no Node-only APIs (except `worker_threads` behind a contract) | Physics, event bus, pure logic, DI contracts |
| `src/server/` | `colyseus` (`@colyseus/core` carries a local `pnpm patch` in `patches/`; re-check on any colyseus bump), `@colyseus/schema`, `@colyseus/ws-transport`, `express`, `zod`, `node:sqlite`, `pino` + `pino-pretty` + `pino-roll`, `web-push`. Multi-VM only: `@colyseus/redis-driver`, `@colyseus/redis-presence` | Authoritative simulation, persistence, lag comp, backpressure |
| `src/client/` | `colyseus.js`, `react`, `react-dom`, `@mui/material`, `@mui/icons-material`, `@emotion/*`, `pixi.js` v8, `pixi-viewport`, `howler`, `zustand`, `nipplejs` | UI, rendering, audio, input, prediction |
| `src/shared-types/` | Pure TS + zod schemas only | Cross-zone contracts |

---

## SOLID Adherence (project-specific bindings)

- **S:** each zone has one concern; each module one axis of change. `PixiRenderer` never handles input; `Reconciler` never renders; `SectorRoom` never formats Pino lines.
- **O:** new weapons / AI / sectors implement existing contracts (`IWeapon`, `IAiBehaviour`, `ISectorDefinition`), not new switch arms.
- **L:** any `IRenderer` / `INetworkSink` (headless, loopback) is drop-in for the real one.
- **I:** contracts stay narrow; `IRenderer`, `IAudio`, `INetworkSink` are never merged.
- **D:** `src/core` declares abstractions; server and client inject concretions at bootstrap. Dependencies point into core, never out.

---

## Repo Map

- `src/core/`, `src/server/`, `src/client/`: zones, each with its own CLAUDE.md. `src/shared-types/`: wire contracts.
- `tests/e2e/` Playwright; `benchmarks/` vitest-bench; `.github/workflows/ci.yml` the enforcement pipeline.
- `docs/architecture/`, `docs/features/`: guides. `docs/LESSONS.md`: chronological gotchas. `docs/SHELF.md`: deliberately parked design work.
- `eslint.config.js`: boundary rules. Weakening a pattern there is weakening invariant #1.

## Phase-Gate Ritual

At each phase gate: update the zone CLAUDE.md rules and the guides whose content changed (#7); append gotchas to `docs/LESSONS.md`; review the invariants and amend this file if one changed.

---

## Keep context small (token budget)

Every call re-reads the whole context, so its size sets the bill.
- **Hand off early.** At a milestone (a PR merges, a stream stage closes) or once context passes ~250k tokens, write the handoff and start a fresh session.
- **Keep subagents in one zone.** Tell each subagent which zone it works in and to stay there: every zone it touches loads that zone's CLAUDE.md for the rest of its life.
- **Search narrow, read by range.** Use the Grep tool or `git grep` scoped to `src/ docs/ tests/ scripts/`, never the repo root. Read files over 600 lines by range after `grep -n`. Cap shell output (`| head -40`). Don't re-read CLAUDE.md files through the shell; they are already in context.

## Commit cadence

Commit at every milestone where the inner loop (`pnpm typecheck && pnpm lint && pnpm test`) is green and the change is a coherent unit, usually one plan step per commit, subject in the imperative with the plan reference. Group only related changes. Never commit yellow code to save progress; `--no-verify` is forbidden. Before a session ends, `git status` is clean or the pending work is noted.

## Clean up at every stage (standing user directive)

"Clean up as much memory as you can at each stage" (a plan step, a commit, a test/netgate/showcase run, the session end):
1. **RAM / processes:** when a run finishes, and before EVERY recording (showcase take, perf scene), stop what this session started (dev 2567/5173, showcase 2767/5373, netgate vite/proxies, headless Chrome, ffmpeg, `tsx watch`; never the user's own Chrome) and check free RAM.
2. **Disk:** scratch lives in the session scratchpad, not `diag/_*`; delete it when its stage ends. Remove a `.claude/worktrees/<x>` worktree once its branch is merged and clean (keep `netgate-baseline` / `netgate-head`). Never delete committed evidence or a dirty worktree without asking.
3. **Auto-memory:** keep `MEMORY.md` under 24 KB, one ~150-char line per note; collapse or delete notes when their plan finishes or a later note supersedes them.

## NEVER build a parallel system (standing user directive)

Owner: "NEVER build a parallel system." When a feature needs something the game already does (AI pilots and tactics, ship drawing, an entity type, a fire path, a UI surface), EXTEND that system with the hooks it needs. Never write a sibling next to it, however much easier or "safer for its tests" that looks. (A sibling `WingmanBehaviour` once lacked the NPC dogfight work and drew ships differently; the owner had never been asked.)

**Every plan gets a hostile review for parallel systems, then the owner is ASKED:**
1. Before a plan is presented or building starts, a separate hostile reviewer agent gets the plan and the codebase (not your conclusion). For each new module / class / behaviour / renderer / message, it names the existing system that already does that job and says whether the plan extends or duplicates it.
2. Any duplicate is a blocker: rewrite the plan to extend the existing system.
3. If a sibling really seems necessary, ask the owner with AskUserQuestion in plain words ("the game already has X; I want to build a second Y because Z — OK?") BEFORE any code. Never decide it yourself or bury it in a plan file.
4. Subagent briefs say the same: "extend existing systems; if you think a new parallel one is needed, stop and report instead".

## End every message with a status line (standing user directive)

The last line of every message is **Continuing:** (what happens next), **Done:** (nothing left) or **Waiting on you:** (a short pointer to the decision).

- **Never end a turn to wait for "continue".** When a plan is approved, execute ALL of it: commit, push, PR (auto-merge) each piece, then start the next piece in the same turn. A phase boundary, an in-flight PR (branch off it) or the size of what's left is not a reason to stop; stop only when the plan is done, for a genuine user decision, or a hard blocker.
- **Pending CI or a long run is not a reason to stop:** start the next independent item meanwhile, in a second worktree or port lane.
- **Decisions go through the AskUserQuestion tool, never as questions in prose.**

## Pushing branches & opening PRs

`gh` is installed and fully authed (user PATH; `%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_*\bin\gh.exe`). Never leave finished, green work unpushed.

```
git fetch origin && git checkout -b <branch> origin/main      # every new branch
git fetch origin && git merge --no-edit origin/main            # right before push; re-run the inner loop
git push -u origin <branch>
gh pr create --base main --head <branch> --title "…" --body-file <scratchpad>/pr-body.md
gh pr merge <n> --auto --merge                                 # ALWAYS, the instant the PR exists
```

- **Auto-merge is part of opening a PR (standing user directive):** `--auto` holds the PR until required CI passes, so it is safe. Report "auto-merge on" with the PR URL.
- **Stay synced with `main`:** sync before every push, re-sync before merge, and for a stack re-sync each remaining branch after any one merges (`git rev-list --count origin/<branch>..origin/main` = 0 means current). Use `git merge`, not rebase, on a pushed branch.
- **Auto-memory is per machine; the user works on two.** Machine-specific facts may go in a memory; any rule, convention or project gotcha goes in the repo (a rule in CLAUDE.md, anything else in `docs/`). When in doubt, put it in the repo.
- If gh auth breaks: `gh auth refresh -h github.com -s read:org` in PowerShell / Windows Terminal (not Git Bash; there prefix `winpty`).

---

## Verification Protocol (after every server-touching change)

Boot the server before reporting success: `timeout 8 pnpm dev:server`. A clean boot prints `INFO: EQX Peri server started port: 2567`; exit 143 is the normal SIGTERM, anything else means the change broke the runtime (decorator transforms, `Symbol.metadata`, ESM resolution) even if typecheck passes. If 2567 is taken, check its owner (next section): stop it only if this session started it; otherwise boot on offset ports.

---

## Work in a worktree; check port owners before using a port (standing user directive)

Several Claude sessions run on this machine at once. So:

- **All work happens in a git worktree** under `.claude/worktrees/<name>` on its own branch, never in the main checkout.
- **Before starting, using or opening any port, check who owns it** (`netstat -ano | findstr LISTENING | findstr ":<port>"`, then the PID's command line). Stop only processes your session started (match the worktree path in the command line); another session's server is never yours to kill, even on the canonical ports.
- **Check immediately before launching, not in parallel with the launch.** When another session is active, prefer offset ports (`EQX_E2E_PORT_OFFSET`, `EQX_SHOWCASE_PORT_OFFSET`, `NETGATE_PORT_OFFSET`, or `PORT=` + `EQX_SERVER_PORT=` + `vite --port … --strictPort`).

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

> **Feature specs run when their area changes (2026-11-06 audit).** CI's only required e2e gate is the smoke tier. The advisory `e2e-feature-affected` job also runs the feature specs for the areas a PR touches, from the map in `tests/e2e/featureTriggers.mjs`; a changed spec always runs itself. When a fix touches an area, add or keep its specs in that map. Known-failing specs sit in its `QUARANTINE` list (see `docs/refactors/test-coverage-audit.md`): remove the entry in the PR that fixes one. Before this, ~30 feature specs rotted unnoticed because nothing ran them.
>
> **`waitForFunction(fn, arg?, options?)`:** the second argument is the function's ARG. Write `waitForFunction(fn, undefined, { timeout })`, or the deadline is ignored (a lint rule enforces it).
>
> **Measurement specs live in `tests/perf/`, never in `pnpm e2e`.** Fixed-window heap/allocation/bandwidth/worker-A-B specs that hold a wall-clock window to gather a number (and are inherently host-load-variance-prone) run **only** via `pnpm e2e:perf` (`playwright.perf.config.ts`, 150 s per-test cap) — they are NOT part of the per-PR `pnpm e2e` regression suite. Adding a spec that waits out a fixed window for a measurement? It belongs in `tests/perf/`, not `tests/e2e/`. See `docs/refactors/test-coverage-audit.md` + the Determinism-refactor section of `docs/architecture/e2e-framework.md`.

> **Parallel E2E lanes: `EQX_E2E_PORT_OFFSET=N`** (integer, default 0). Playwright then boots its own game server on 2567+N and Vite on 5173+N (`--strictPort`, HMR 24678+N, proxy → 2567+N) and every spec/helper URL follows, via `tests/e2e/helpers/ports.ts` (never hard-code `localhost:2567`/`5173` in a spec; `PLAYWRIGHT_BASE_URL`/`PLAYWRIGHT_SERVER_URL` still override). A non-zero offset is its own lane and never reuses an existing server, so a taken port fails loudly. Pick a free N per worktree (check `netstat -ano | findstr LISTENING` for 2567+N/5173+N first), e.g. `EQX_E2E_PORT_OFFSET=410 pnpm e2e tests/e2e/boot.spec.ts`. Offset 0 is the canonical pair, unchanged (reuse included). Covers `playwright.config.ts` only; the perf/diag/mobile configs still use 2567/5173.

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

**Scenarios — it gates HEALTH, never correctness (multi-scenario, plan: misty-teapot).** The catalogue is `tests/netgate/scenarios.ts` (`SCENARIOS[]`, the single source of truth for BOTH the spec and CI selection). `core` (`feel-test-25`, 25 drones, gated) is the foundational local-feel check. The print-only `structures-load` / `scrap-load` scenarios were removed (wrap-up W4, 2026-11-09): they gated nothing and never met their promotion bar. Load-bearing distinction: every gated metric measures the **LOCAL PLAYER's prediction reconciliation**, so the netgate CANNOT detect a structures/scrap *correctness* regression; that is gated DETERMINISTICALLY (`BinarySwarmBroadcast`/`BinarySwarmDecoder` tests, `tests/unit/swarmWireRoundTrip.test.ts`, `scrapOnDeath`/`structureScenario`/`structureGrid` integration), and structure/scrap load cost is measured by the perf scenes. Galaxy is deliberately out (client-render path, covered by deterministic E2E).

**When required (invariant #8 corollary).** Any PR matching a scenario's `triggerGlobs` in `scenarios.ts` — `core`'s set is SHARED live-loop (`src/client/net/`, `src/core/prediction|physics/`, `WeaponMountController`, `SectorRoom`/`SnapshotBroadcaster`/`EntitySyncRouter`, `swarmWireFormat`, `messages/`) **∪ STRUCTURE** (`src/server/structures/`, `src/core/structures/`, `structureKinds.ts`) **∪ SCRAP** (`ScrapSpawner.ts`, `scrapCollider.ts`, `scrapConstants.ts`). The structure/scrap server paths were a **false-negative hole** in the old hand-maintained regex (a pure structures/scrap logic change SKIPPED the gate); they now correctly fire `core`. CI does the selection itself (`tests/netgate/select-scenarios.mjs`, **fail-closed**: an error / empty / API-truncated / unenumerated-live-loop-path diff runs ALL gated scenarios; only a provably non-live-loop diff skips). You don't predict from `git diff` — the gate's pass/fail IS the verdict.

**How to run.**

- `pnpm e2e:netgate` — defaults: scenarios `core`, baseline `origin/main`, head = working tree, primary mobile profile (≈120 ms RTT ±60 ms, 0 % drop), 4 interleaved reps `A/B/A/B/A/B/A/B`. `NETGATE_SCENARIOS=<csv>` selects scenarios (each is its own Playwright `test()`); the netgate `workflow_dispatch` has a `scenarios` input.
- The driver (`tests/netgate/run-netgate.ts`) creates two git worktrees under `.claude/worktrees/netgate-{baseline,head}` (incremental — preserves `node_modules` across runs), boots two `vite` dev servers with HMR disabled on both, starts a per-arm HTTP+WS latency proxy, and runs `tests/e2e/netcode-health.spec.ts` interleaved on each. ~6–8 min for a single-scenario acceptance run.
- **The gate's pass/fail IS the verdict.** Do NOT predict from `git diff`. "Those commits don't touch netcode so it's probably fine" is the falsified cop-out class the user's memory specifically flags — the gate exists so we never make that prediction. Read the metric + magnitude, report it. If RED, `git bisect run pnpm e2e:netgate` narrows it.

**What it gates (single source of truth: `tests/netgate/netHealthBudget.ts`).** `ticksAhead`, `maxDriftUnits`, `meanDriftUnits`, `droppedSnapshotsRecent` — each metric uses a **relative AND absolute** AND-gate (head must be both worse than baseline by margin AND past the documented playable ceiling to fail). Improvements (ratio ≤ 1) can never fail. Liveness preconditions (`snapshotCount > 40`, `diagEnabled === false`) are a DISTINCT result channel — "the gate did not validly run" must never read as "healthy."

**Print-only (NOT gated).** `rollingCorrRate` (demoted 2026-11-05: `main` vs identical `main` FAILED the gate, 0.45 vs 0.95; same-code spread 0.3–0.95 exceeds its 0.6 ceiling). `snapshotJitterMs` and `rtt*` are proxy-jitter-dominated — their baseline variance over identical-code reps (19.5–130.8 ms for jitter; 6.7× spread) exceeds any sensible margin. Same disqualifier the plan used to exclude `rtt*` at the outset. Re-adding either without solving the injected-jitter confound is a deliberate, reviewed change.

**Don'ts.**

- **Don't add it to the inner loop.** Multi-minute + worktree-creating. The deterministic suite stays the inner loop; the netgate is a conditional outer gate.
- **Don't measure the gate with `?diag=1`.** Phase-0a's `?diag=0` URL override + `__resetDiagCache()` is the entire reason the gate measures the production code path (Playwright sets `navigator.webdriver=true` which auto-enables diag; without the override every spec measures an instrumented build no player ever runs). The spec asserts `__eqxDiagEnabled === false` before reading stats.
- **Don't widen a margin to silence a flake.** If it flakes, characterise the variance with `main`-vs-`main` ≥ 3× and either fix the *metric set* (demote → print-only, like `snapshotJitterMs`) or fix the *mechanism*, not the threshold. The whole anti-flake architecture is mechanism not margin.
- **Don't bypass the measurement-harness overlay.** The driver copies the working tree's `ClientLogger.ts` + `vite.config.ts` onto every worktree before booting its dev server — the measurement harness must be uniform across arms; each ref keeps its own netcode. Booting a pre-Phase-0a ref naïvely makes the diff a harness mismatch, not a netcode delta.

**Auto-retry ONCE, then BELIEVE it (policy 2026-06-15 — corrects the earlier "never retry" purism).** The netgate is a relative measurement and is variance-prone on contended hosted runners; empirically every recurring RED cleared on a fresh-runner re-run, so the "never retry, only characterise" stance was bad advice in practice. The separate **`auto-retry.yml`** workflow (`workflow_run`-triggered) **auto-re-runs a failed CI/Netgate run's failed jobs exactly once on a fresh runner** (`run_attempt == 1` guard — `rerun-failed-jobs`). It MUST be a separate workflow: `rerun-failed-jobs` is rejected (HTTP 403 "workflow is already running") if called from a job INSIDE the still-running run, and `workflow_run` only fires from the default branch (so it takes effect once merged to main). This is NOT retry-until-green: a failure that **survives the retry (attempt ≥ 2) is LEGITIMATE.** Treat it as a real regression — **investigate the netcode; do NOT report it as a "host flake" or "the box."** Deflecting a surviving failure to the host is the exact reflex this policy exists to stop. Widening a margin to silence a flake is still forbidden (mechanism, not margin). When a surviving RED really is environmental, the fix is a *mechanism* one (a quieter/self-hosted runner, a baseline-sanity liveness precondition), surfaced as such — never a shrug.

---

## Showcase video (`pnpm showcase`) — a feature adds a shot

The showcase reel is a **repeatable build artefact**, not a one-off edit: `pnpm showcase [--ref origin/main] [--shot <id>]` records every shot in `showcase/shots/` against an isolated server pair (2767/5373, temp DB — never touches a dev session) in headless Chromium on the real GPU, captions it, QA-checks it (frame rate / freezes / blank frames) and cuts `showcase-out/reel-1080p.mp4` (gitignored). Camera moves are plain-data scripts played by the `CameraDirector` (`?cinematic=1`, `window.__eqxCinema`). **Rule: a new player-facing feature ships with a shot (or a reasoned `SHOWCASE_EXEMPT`/`SHOWCASE_PENDING` entry in `showcase/registry.ts`)** — `tests/unit/showcaseCoverage.test.ts` fails CI on any `docs/features` / `docs/architecture` page that is none of filmed / exempt / pending. Requires ffmpeg (`winget install Gyan.FFmpeg`). Full story: [docs/architecture/showcase-pipeline.md](docs/architecture/showcase-pipeline.md) + [docs/architecture/cinematic-camera.md](docs/architecture/cinematic-camera.md).

**Record the game as it is; never stage it for the video (2026-11-10, standing user directive).** Clips are for the owner to judge the look and feel. User: "Don't hide shit for a good demo, that's the antithesis of what I want you to do. Record as is and then let me be the judge. Genuine bugs, stutter, lag, stuff not firing, bad graphics, all fine to fix on sight. But don't be like 'this just doesn't make a good video but is working as intended so I'll change it for the video'." So:
- Never hide game UI or effects, re-stage a shot, move a scene, or change behaviour only to make a clip look better.
- The camera follows the pilot's ship as in play; a pan or free camera only in spectator mode (`ctx.spectate()`; `ctx.cinema.play` throws otherwise), and no test cue changes play during the take (setup before it is fine). See [showcase-pipeline.md](docs/architecture/showcase-pipeline.md).
- Fix genuine bugs found while filming or reviewing (with the failing test first, invariant #13).
- A hostile reviewer's "works, but makes a poor video" findings go to the owner as notes, not into changes.
- Clips film the full HUD with no `cleanworld` (user, 2026-11-10: "Show everything"). `targetUrl` forces `FILM_HUD = 'full'` and ignores a shot's `hud`; lock `showcase/targetUrl.test.ts`.

**Frame-rate QA counts DIFFERENT frames, at the encode (2026-11-10).** QA said "60 fps" while clips showed ~25 different frames a second: ffmpeg's concat demuxer read each JPEG at a 25 fps time base (fix: `option framerate 60` per entry, `CONCAT_FRAMERATE`). Takes now gate `uniqueFps` (captured, byte-identical repeats count once) and `encodedUniqueFps` (ffprobe of the concat list) at the same ≥ 55 as `deliveredFps`; all are in `manifest.json`. Lock: `showcase/cadence.test.ts`. See `docs/LESSONS.md` 2026-11-10.

**Shots film the player's look, not the test look (2026-11-10, user: the clips "didn't have the full graphics and shadows turned on").** The capture browser is automated, and automation defaults to classic art and baked lighting (`artMode.ts`). `targetUrl` therefore adds `PLAYER_LOOK` (`art=machined&fx=new&shiplight=high`, a desktop player's default) to every shot; a shot's params or `EQX_SHOWCASE_PARAMS` override it. Lock: `showcase/targetUrl.test.ts` compares it with the game's own desktop default.

**A hostile reviewer checks every clip before the user sees it (2026-11-07, standing user directive).** The take QA gates measure frame pacing, not whether the clip shows what it should. Before handing a clip to the user, give a hostile reviewer agent full-resolution frames around every key moment (10 fps crops, not a contact sheet) plus the clip's goal in one sentence, and ask it to find anything that looks wrong: an effect not lined up with its ship, a ship jumping or appearing in the wrong place, something pointing the wrong way, old effects that should be gone. Send every reviewed clip to the user straight away: one that passes the review is presented as finished; one that fails is shared as WIP, labelled so, with the review's caveats (2026-11-12: "share first with a caveat so I get a feeling"; "present it as finished, otherwise share as a WIP"); then fix what it found and re-film. The user's words: "this is easy to identify surely? It just doesn't look right".

**Smoothness gets its own check: 10 fps frames can't show it (2026-11-12, the long-guns zoom "chugs like crazy").** The reviewer passed a clip whose camera lurched and stopped six times a second on every wheel notch, and the take QA said 60 different frames a second because the HUD text kept changing while the world stood still. For every camera move or fast motion in a clip, compare each frame with the next at the full 60 fps (ffmpeg `psnr` with a `stats_file`, as in LESSONS 2026-11-12): runs of near-identical frames (PSNR > ~55 dB) while the scene should be moving, or one frame that jumps much further than its neighbours, are a stall or a lurch. Before blaming the recorder, check the game without recording (`?perfprobe=1`, `__eqxPerf`) and, for a camera move, the per-frame camera scale or position. Then report it or fix it like any other finding.

**Look and feature R&D happens in the game, behind a flag, on a branch (2026-11-08, standing user directive).** Not in a parallel renderer: the art lab lacked turrets, the game's effects, shields, fences and sky, so its clips misled ("I just don't think doing all of this work on some weird parallel system makes sense. It should be in the game, just use flags and switches and ultimately git branches to isolate"). Film it with `EQX_SHOWCASE_PARAMS=<flag>` on existing shots and measure it with `pnpm perf:scenes --base <sha> --head-params <flag>`. Example: GPU-lit art (`?shiplight=gpu`, [docs/architecture/gpu-lit-ships.md](docs/architecture/gpu-lit-ships.md)).

---

## Perf scenes (`pnpm perf:scenes`) — measure what a change costs

Scripted scenes in real rooms (a fleet fight, a raid warping in beside a base, a wide view over a battle), played in a real browser on the real GPU. The runner records server tick and frame-time percentiles, hitches, renderer cost, bytes per second and display objects, then compares head with `origin/main` interleaved on the same machine in the same session.
- **Counts gate; timings compare against the same-session base.** Never against a stored number from another day or machine.
- **Percentiles and hitch counts, never mean FPS.**
- **An invalid run is never "fast".** Refused spawns, a scene that never ended or too few frames ⇒ INVALID.
- **Trust a metric only after its self-test.** main-vs-main must come back GREEN, and `--inject-server-burn` / `--inject-client-burn` must go RED on that metric.
- **Three verdicts: RED, GREEN, INCONCLUSIVE (2026-11-08).** INCONCLUSIVE means the run could not tell (too few reps, over threshold but not significant, or inside the host's A/A noise). It is NOT a pass: never report it as GREEN or base a decision on it; add reps or use a quieter host. **At least 4 reps per arm** (`--reps` defaults to 8, odd counts round up): a 3-rep exact Mann-Whitney's smallest p is 0.10, so 3 reps can never go RED and its "GREEN" is vacuous (the 3-rep GPU-lighting A/Bs of #344–#346 were). Use `--noise-check` (A/A arm; default for same-commit, same-params runs) on a noisy host; a move inside the same-code spread reads "within host noise (×N)".
- **The runner refuses a busy host, rep by rep (2026-11-08).** Free RAM < 1 GB, CPU > 25 % before a rep, or another session's game server / Vite listening ⇒ that rep is INVALID and repeated (≤ 2). Another session on this machine? Run with `EQX_SHOWCASE_PORT_OFFSET=300` (perf and showcase) so neither kills the other's servers, and only pass `--ignore-ports` for listeners you know are idle. Showcase takes record the same samples in `manifest.json` (`hostLoad`).
- **Phone-class checks need no phone (2026-11-08, user: "I can't do that").** `--device phone-proxy [--cpu-rate 2]` runs the same A/B on this machine with a throttled CPU and a phone screen. Its absolute numbers are far slower than a real phone; trust only base-vs-head. Don't ask the user to run phone tests or set up adb.
- **Claude runs it, not the user.** It is part of Claude's own verification before a PR that touches rendering, the server tick, the snapshot path or combat at scale. The verdict table goes in the PR body.

Adding a scene is one entry in `src/server/rooms/scene/perfScenes.ts`. Full story: [docs/architecture/perf-scenes.md](docs/architecture/perf-scenes.md).

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
| `instantLock: boolean` | Lock-to-fire (#19) without the wait: every lock of this pilot completes on the next lock step (≤ 100 ms; a failsafe still commits its hostile act). AUTO targeting is unchanged (hostile only). The trigger for every spec that fires but isn't about locking. | `JoinOption`, testMode-only. URL `?instantLock=1` in `gameSurfaceBootstrap.ts`; `TestClientOpts.instantLock`. Integration: `harness.lockTarget(pid, target)` (`_internals.forceLock`). | Fixed guns still fire only with the target within 0.2 rad of the nose. Lock: `LockSubsystem.test.ts`. |
| `lockTimeCapS: number` (room opt) | Lock-to-fire for NON-player guns without the long wait: no lock by an NPC drone / capital (on a pilot), a capital turret (on a structure) or a structure / coastal turret takes longer than N s while in reach; 0 = the first lock step. Still acquired (#19), only faster. Big-gun locks are slow by design; this is for tests and recordings. | Room option read in `SectorRoom.onCreate` (zod, testMode), or the room-creating client's join option: URL `?lockTimeCapS=N` (`gameSurfaceBootstrap.ts`), `TestClientOpts.lockTimeCapS`, a showcase shot's `target.params`. Integration: `bootSectorTestServer({ lockTimeCapS })`. Math: `capLockSeconds` (`core/combat/lockTime.ts`). | In reach only (out of reach stays unlockable). No existing room or shot sets it: a shot opts in deliberately. Player locks use `instantLock` (an N-s player cap would split the client's lock-ring prediction, #15). Lock: `lockTime.cap.test.ts`, `capitalLockGate.test.ts`, `tests/integration/sectorRoom/lockTimeCap.test.ts`. |
| `timeScale: number` (room opt / join opt) | This SECTOR's game speed, 0.25–4× (time scale stream, per sector): the room's clock, timers, update loop and physics world all run at it; snapshots carry the `timeScale` keyframe while it isn't 1. For demos, videos and slow motion. | Room option read in `SectorRoom.onCreate` (zod, testMode); join option (testMode or `EQX_ALLOW_DEV_OVERRIDES`): URL `?timeScale=N` (`gameSurfaceBootstrap.ts`), `TestClientOpts.timeScale`; env `EQX_TIME_SCALE` (every sector, not in production); `POST /dev/time-scale?room=<roomId|sectorKey>&scale=N`. Integration: `bootSectorTestServer({ timeScale })`. | Stream-only until it lands. The client does not follow it until Phase 4 of the stream (expect prediction corrections before then). `testTimeScale` stays the separate physics-only test accelerator for now. Lock: `tests/integration/sectorRoom/timeScale.test.ts`. |
| `anyTarget: boolean` | This pilot's AUTO groups also pick non-hostile NPCs and non-own structures in reach + arc. Pair with `instantLock` for a spec whose AUTO group must shoot a neutral drone / structure. | `JoinOption`, testMode-only. URL `?anyTarget=1` in `gameSurfaceBootstrap.ts`; `TestClientOpts.anyTarget`. | Never auto-picks players (use `lockOn` / `lockTarget`). Not for showcase combat takes (the pilot could fire on a neutral structure). Lock: `LockSubsystem.test.ts`. |
| `groupMode: 'manual'` | Every weapon group of the joining pilot starts in MAN, so AUTO never self-picks a target. Pair with `instantLock` (and `anyTarget`, if used) when an AUTO group (e.g. the point-defence laser) would kill a fragile target before the test switches the group it wants to AUTO. | `JoinOption`, testMode-only. URL `?groupMode=manual` in `gameSurfaceBootstrap.ts`; `TestClientOpts.groupMode`. Applied per player in `LockSubsystem.enable`. | A group the pilot switches to AUTO afterwards behaves normally. Lock: `LockSubsystem.test.ts`, `fireControlLocks.test.ts`. |
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
| `sceneScript` (room opt) | A timed list of world events for a perf scene: `spawn` N ships of a kind in a deterministic disc at a time (`warpIn` shows the warp-in effect, `hostile` marks them hostile to every pilot), then `end`. The clock starts when the first pilot is ready. Drones and robots spawned together fight on sight, so a fleet fight needs no extra order. | `SectorRoom.initSceneScript` → `rooms/scene/SceneScriptRunner.ts` (zod-validated, testMode-gated, ≤ 64 steps / ≤ 64 ships a step). `sceneStatus()` reports started / spawned / refused / ended. | A refused spawn (slot pool full) makes a perf run invalid. Ships start out of weapon range only if you want an approach; place the sides within a few hundred units for an immediate fight. Lock: `SceneScriptRunner.test.ts` + `tests/integration/sectorRoom/sceneScript.test.ts`. |
| `test_aggro` message + the `showcase-capital-duel` room | `test_aggro` (testMode) turns every drone in the room hostile to the sender NOW, the same as `startHostile`, so a shot starts a fight after its art has baked. Hostility decays 30 s after the latest of: the pilot's last hit on the drone, the end of the pilot's last lock on it (2026-11-10), the drone's last hit on the pilot, or the end of the drone's own last lock on the pilot (an attacking NPC stays hostile, 2026-11-12; its lock drops out of reach, so a pilot who leaves is forgotten 30 s later); a showcase take sends it once before recording and never re-sends it during the take (record as is). The duel room is one battleship at the origin and the pilot 4,000 u off its starboard beam (`showcase-capitals-combat` is the five-capital line-up with live brains). | `SectorRoom.markAllDronesHostileTo`; schema `TestAggroSchema`; rooms in `rooms/showcaseRooms.ts`. | At the real 4°/s a 16" turret needs ~25 s to train onto the beam; cue the fight before recording. The integration test starts the battleship bow-on so its forward turrets already bear. Lock: `tests/integration/sectorRoom/capitalEngagement.test.ts`. |

| `capitalWrecks` (room opt) | Capital destruction S2a: a dying capital (NPC or player-flown) breaks into solid wreck bodies on the server (swarm kind 4, server-only). Off by default, because clients don't draw wrecks until S3. `EQX_CAPITAL_WRECKS=1` turns it on for every room. | `SectorRoom.initCapitalWrecks` → `rooms/CapitalWreckSubsystem.ts`; the integration harness forwards it. Seams: `_internals.wreckState` / `wreckParts` / `setWreckSeed` / `rayHit`. | Never turn it on for a room a player films or plays until S3 draws wrecks (invisible walls). Lock: `tests/integration/sectorRoom/capitalWrecks.test.ts`. |
| `test_kill_capitals` message + the `wreck-test` room | Capital destruction: every capital NPC in the room takes a lethal hit NOW (re-hit through a shield), so a spec sees the wreck without a gun duel. The room holds a peaceful battleship 2.5 km north of the spawn with `capitalWrecks` on. | `SectorRoom` (testMode); schema `TestKillCapitalsSchema`; room in `src/server/index.ts`. | Drives `tests/e2e/capital-wreck-render.spec.ts`; integration lock in `wreckLateJoiner.test.ts`. |

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
