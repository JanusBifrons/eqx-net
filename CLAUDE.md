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

## Stale dev servers cause "phantom" E2E failures

- Playwright reuses whatever listens on 2567/5173 (`reuseExistingServer: true`), and a stale server runs old code: a flood of `boot.spec.ts` timeouts means a stale server, not a broken spec.
- Before a server boot or E2E run, stop the servers on those ports that THIS session or worktree started (worktree path in the PID's command line), then boot fresh; don't dodge onto `PORT=2568` with your own leftover still running. Another session's server is never yours: use an offset lane (`EQX_E2E_PORT_OFFSET`) instead.
- Keep `reuseExistingServer: true`; for a diagnostic loop set `CI=1` so Playwright spawns a fresh server. Commands and detail: [docs/architecture/e2e-framework.md](docs/architecture/e2e-framework.md) "Running E2E specs".

## Running E2E Tests

**Before running any E2E spec, read [docs/architecture/e2e-framework.md](docs/architecture/e2e-framework.md) "Running E2E specs" (the playbook).** To triage a red spec: `.claude/skills/e2e-triage/SKILL.md`.
- Announce the expected duration and the Bash timeout before starting; never invent wall-clock times. Set the timeout tight (expected runtime + ~30–50 %, max 10 min); always pass one.
- Narrow first: one spec, `--project=chromium`, `--reporter=line`, `--grep`. Run the full suite only in the background, output redirected to a log you `Read`.
- Inner loop on every change: typecheck + lint + unit + the 8 s server boot. Targeted E2E is the outer loop.
- Specs that wait out a fixed window for a measurement live in `tests/perf/` (`pnpm e2e:perf`), never `tests/e2e/`.
- When a fix touches an area, keep its specs in `tests/e2e/featureTriggers.mjs`; remove a `QUARANTINE` entry in the PR that fixes that spec.
- Never hard-code `localhost:2567`/`5173` in a spec (`tests/e2e/helpers/ports.ts`). Write `waitForFunction(fn, undefined, { timeout })`.

## Netcode-health gate (`pnpm e2e:netgate`) — required for live-loop-touching changes

**Before running it or reading its verdict, read [.claude/skills/netgate/SKILL.md](.claude/skills/netgate/SKILL.md)** (how it works, scenarios, metrics, retry policy).
- Required (invariant #8) for any PR matching a scenario's `triggerGlobs` in `tests/netgate/scenarios.ts`; CI selects scenarios itself, fail-closed.
- The gate's pass/fail IS the verdict: never predict from `git diff`; report the metric and magnitude; on RED, `git bisect run pnpm e2e:netgate`.
- It gates the local player's prediction health, not structures/scrap correctness (those are deterministic tests). A precondition failure means "did not validly run", never "healthy".
- Never widen a margin to silence a flake: characterise `main`-vs-`main` ≥ 3×, then fix the mechanism or demote the metric to print-only.
- Never in the inner loop; never measure with `?diag=1`; never bypass the driver's measurement-harness overlay.
- CI re-runs a failed run once (`auto-retry.yml`). A failure that survives the retry is a real regression: investigate the netcode, never call it a host flake.

## Showcase video (`pnpm showcase`) — a feature adds a shot

**Before filming or reviewing a clip, read [docs/architecture/showcase-pipeline.md](docs/architecture/showcase-pipeline.md)** ("Filming and review rules"; camera: [cinematic-camera.md](docs/architecture/cinematic-camera.md)).
- A new player-facing feature ships with a shot, or a reasoned `SHOWCASE_EXEMPT`/`SHOWCASE_PENDING` entry in `showcase/registry.ts` (`tests/unit/showcaseCoverage.test.ts` fails CI otherwise). A docs page that will never be filmed exempts itself with `<!-- showcase-exempt: <reason> -->` near its top, so a docs PR stays markdown-only.
- Record the game as it is: never hide UI or effects, re-stage, or change behaviour only for a clip; the follow camera while piloting, a pan only in spectator mode, no test cue during the take. Fix genuine bugs (failing test first); "poor video" findings go to the owner as notes.
- Clips film the full HUD (no `cleanworld`) and the player's look (`PLAYER_LOOK`).
- A hostile reviewer checks every clip (full-res frames at key moments + the clip's goal) before the user sees it; send it straight away, as finished if it passes, else labelled WIP with the caveats; then fix and re-film.
- Check every camera move or fast motion frame-to-frame at 60 fps (PSNR) for stalls and lurches.
- Look and feature R&D happens in the game behind a flag on a branch, never in a parallel renderer.

## Perf scenes (`pnpm perf:scenes`) — measure what a change costs

**Before running a perf A/B or adding a scene, read [docs/architecture/perf-scenes.md](docs/architecture/perf-scenes.md).** Scenes live in `src/shared-types/perf/perfScenes.ts`.
- Claude runs it, not the user, before a PR that touches rendering, the server tick, the snapshot path or combat at scale; the verdict table goes in the PR body.
- Counts gate; timings compare only against the same-session base arm. Percentiles and hitch counts, never mean FPS.
- INVALID is never "fast"; INCONCLUSIVE is never a pass; at least 4 reps per arm. Trust a metric only after its main-vs-main and injected-burn self-test.
- Another session on the machine: use `EQX_SHOWCASE_PORT_OFFSET`, `--ignore-ports` only for listeners you know are idle. Phone-class checks use `--device phone-proxy`; never ask the user to run phone tests.

## Test-harness philosophy — bespoke gameplay triggers, never bump timeouts

**Before writing or fixing an E2E spec, read the trigger catalogue in [docs/architecture/e2e-framework.md](docs/architecture/e2e-framework.md) "Bespoke gameplay triggers".**
- Target 1–2 s wall-clock per test. A test waiting on game time (TTK, travel, regen, spool, respawn, TTL, cadence) gets a bespoke trigger (find or add one), never a bigger timeout. Only infrastructural cost (navigation, cold boot, join, Vite compile) justifies a budget bump.
- Reject in review: `test.setTimeout` raised without a trigger, `waitForTimeout` pacing past a game-time wait (use `waitForFunction` with a deadline), wall-clock duration asserts tied to tuning, tests that break on every tuning PR.
- Add a new primitive when 3+ tests need the same skip; document it in the catalogue in the same PR.
