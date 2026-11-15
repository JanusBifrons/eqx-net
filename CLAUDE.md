# CLAUDE.md — EQX Peri (Root)

You are working in **EQX Peri**, a multiplayer space game. Read this before any non-trivial change. Zone rules load when you touch a file in the zone: [src/core/CLAUDE.md](src/core/CLAUDE.md), [src/server/CLAUDE.md](src/server/CLAUDE.md), [src/client/CLAUDE.md](src/client/CLAUDE.md).

**What goes where.** CLAUDE.md files hold **rules only**: short, present tense, no dates, no PR numbers, no history. How a subsystem works, thresholds and tuning values, and history go in the matching guide under `docs/architecture/` or `docs/features/` (history in the guide's "History" section), with a one-line pointer from CLAUDE.md. Gotchas go in [docs/LESSONS.md](docs/LESSONS.md). Every CLAUDE.md is injected into every agent's context, so each line here costs on every call. CI enforces a byte budget per file (`node scripts/audit-god-files.mjs --claude-md`): when one is over, move text out, never raise the budget.

The Master Architecture Blueprint is the authoritative design document; the approved plan under `C:\Users\alecv\.claude\plans\` is the roadmap. When the blueprint and a zone CLAUDE.md disagree, the most recently updated CLAUDE.md wins.

Full text of the invariants, event bus, SOLID bindings and allowed libraries per zone: [foundations](docs/architecture/foundations.md). Full text of the workflow rules below: [agent-workflow](docs/ops/agent-workflow.md).

## Cross-Phase Invariants (ALL must hold at every phase gate)

1. **Boundary integrity.** `src/core` imports no client or server library; `src/server` no client library; `src/client` no server-only package or Node-only API. Enforced by `no-restricted-imports` and `depcruise src`; the canary `src/core/__fixtures__/leak.ts.disabled` must break both when enabled. Weakening a boundary pattern in `eslint.config.js` weakens this invariant.
2. **Zustand purity.** No spatial field (`x`, `y`, `vx`, `vy`, `angle`, `rotation`, `position`, `velocity`, `*X`/`*Y`) in the store (lint + `zustandPurityLint.test.ts`); spatial state lives in the render mirror. A new key joins the justified allowlist by argument, never by naming around the lint.
3. **Network validation.** Every inbound server message has a zod schema; a malformed packet is dropped with a sampled `pino.warn` and never reaches game logic.
4. **Fixed timestep.** `world.step(1/60)` inside a `while (accumulator >= fixedDt)` loop; no variable-dt physics.
5. **DI seams.** `src/core` never constructs a renderer, audio, network sink or persistence; zones inject them at bootstrap via `src/core/contracts/`.
6. **SOLID adherence** (below), enforced at code review.
7. **Docs currency.** A PR that changes an invariant, adds a contract or threshold, or teaches a lesson updates the docs in the same PR: rule → zone CLAUDE.md (≤ 3 lines); threshold, tuning or how-it-works → the `docs/architecture/` guide; gotcha → `docs/LESSONS.md`. Merging without touching any? Ask whether the PR teaches something.
8. **Green bars before done.** `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e && pnpm bench` pass. A live-loop change (client `net/`, `prediction/`, physics, render loop, snapshot decode/interpolate, mount aim, `SectorRoom` tick/snapshot) also needs `pnpm e2e:netgate` green against baseline.
9. **Tests accompany every behavioural change.** A physics, prediction, obstacle-sync or collision change includes a new or updated `tests/e2e/` test that would have caught the regression; manual verification is not enough.
10. **Docs ship with features.** Every major feature ships a prose guide in `docs/features/` (player-facing) or `docs/architecture/` (internals): the why, the migration path, the future plans.
11. **Ship- and structure-kind catalogues are append-only.** `SHIP_KINDS_LIST` and `STRUCTURE_KINDS_LIST` order is wire format: append only; removing or reordering bumps `SWARM_WIRE_VERSION` and the decoder hard-fails the old version. Bump `STRUCTURE_KIND_CATALOGUE_VERSION` only when an existing record changes. Scrap and wreck-piece geometry is derived client-side, never sent.
12. **One owner per moving-entity state.** Only `WeaponMountController.tickSlot` writes mount angles; a player's mounts aim only at their group's lock target. Drones have no client AI: drone, scrap and wreck pose comes only from the binary swarm wire via `interpolateSwarmPose`. **Collision bodies:** each remote moving entity has one collision path, reset to its authoritative state each snapshot, never re-posed per frame (full rule: [foundations](docs/architecture/foundations.md)); never add a second.
13. **Smoke-test bug reports get a failing test BEFORE the fix.** Reproduce in a test that fails on current code, fix, commit both together. Test at the level where the bug lives; a test that passes first time is in the wrong place; a bug that survives a fix gets its next test at a different level. Workflow: [diagnostic-captures](docs/architecture/diagnostic-captures.md#from-a-smoke-test-report-to-a-failing-test).
14. **No new hot-loop allocation.** Code reached from `update()`, any `tick()`, `render()`/RAF, `handleSnapshot()`, `tickPhysics()` or `onMessage()` allocates nothing: no new collections or typed arrays, `{}`/`[]` literals, `.map/.filter/.slice/.concat`, `Array.from`, JSON, `structuredClone` or template-literal keys. Reuse scratch or `src/core/pool/`; tolerated debt is tagged `// TODO: alloc-debt`, never added.
15. **Two-sided contracts change on both sides or not at all.** A value or behaviour on both sides of the wire lives in shared code or ships a test that FAILS when the sides disagree. Review every fix with "what is the other side of this, and did we touch it?"
16. **Client-visible state is reconstructible from snapshot ∪ join payload.** Discrete events only speed things up; a late joiner converges from snapshots alone. Client-visible state carried ONLY by an event is a review rejection.
17. **Liveness predicates are enumerated, not improvised.** A ship is exactly one of ACTIVE / LINGERING / DEAD; every loop over ships gates on a named shared predicate and a new loop comments which classes it covers. TRAVELLING hulls skip world-facing loops; NPC fire control engages pilots only through `isEngageablePilotHull`.
18. **Size-dependent numbers come from `shipTuning`, never a constant.** Read them from `shipTuning(kind)` / `tuningFor(id)`; a fixed `20` is a bug. Tests locking authored (1×) numbers use `describe.runIf(AT_AUTHORED_SHIP_SCALE)`.
19. **No weapon fires without a completed lock on its target.** The server refuses a group with no LOCKED target, and any mount not bearing on it (`mountBearsOn`), without spending cooldown or energy; NPCs and turrets lock too; locks work at any distance, only firing is range-limited; the client mirrors the gate. Tests use `instantLock` / `lockTarget` / `lockOn`, never a bypass.
20. **Game time is the default; each sector has its own speed** (0.25–4×). All gameplay and presentation time follows the room's `gameClock` (`gameNow()` family across sectors; client `ColyseusClient.gameClock`, `PixiRenderer.fxNow()`). Real-time APIs are lint errors outside the allowlist (`-- real time: <why>`). Never add a per-feature speed factor.

## Event Bus Architecture (read before adding any signalling)

Two channels, never blended. The discrete bus (`src/core/events/Bus.ts`) carries instantaneous low-frequency events as one discriminated union (no stringly-typed emits); per-frame spatial data is polled from the render mirror, **never** emitted (a continuous-data event is a review rejection; the renderer never subscribes for positions). The bus is per-process; cross-process signals arrive over a wire and are re-emitted on the receiver's bus.

## SOLID Adherence

**S** one concern per zone, one axis of change per module. **O** new weapons / AI / sectors implement existing contracts, not new switch arms. **L** any `IRenderer` / `INetworkSink` is drop-in. **I** contracts stay narrow, never merged. **D** core declares abstractions; dependencies point into core, never out.

## Performance

Budgets table: [perf-scenes](docs/architecture/perf-scenes.md#performance-budgets-and-rules). **Gate on counts, compare timings.** A per-PR test never asserts a wall-clock bound: count the work or print the time. Timings are judged only by `pnpm perf:scenes`. A count budget is calibrated locally AND on CI, else print-only. Budgets are raised only on a NEW measurement, never widened to get green.

## Repo Map

Zones `src/core/`, `src/server/`, `src/client/` (each with its CLAUDE.md); `src/shared-types/` wire contracts; `tests/e2e/` Playwright; `benchmarks/`; `.github/workflows/ci.yml`; guides in `docs/architecture/`, `docs/features/`; `docs/LESSONS.md` gotchas; `docs/SHELF.md` parked design work. A zone uses only the libraries listed for it in [foundations](docs/architecture/foundations.md#technology-stack-matrix).

**Phase-gate ritual:** update the zone CLAUDE.md rules and guides that changed (#7), append gotchas to `docs/LESSONS.md`, review the invariants.

## Keep context small (token budget)

Every call re-reads the whole context, so its size sets the bill.
- **Hand off early.** At a milestone (a PR merges, a stream stage closes) or once context passes ~250k tokens, write the handoff and start a fresh session.
- A PostToolUse hook (`scripts/dev/context-nudge.mjs`) reminds you once at 250k and once at 400k.
- `.claude/agents/general-purpose.md` is the built-in helper minus the `Artifact` tool (~14k tokens a call); keep its prompt in step with the built-in.
- **Keep subagents in one zone.** Tell each subagent which zone it works in and to stay there: every zone it touches loads that zone's CLAUDE.md for the rest of its life.
- **Search narrow, read by range.** Use the Grep tool or `git grep` scoped to `src/ docs/ tests/ scripts/`, never the repo root. Read files over 600 lines by range after `grep -n`. Cap shell output (`| head -40`). Don't re-read CLAUDE.md files through the shell; they are already in context.

## Standing user directives

Full text and commands: [agent-workflow](docs/ops/agent-workflow.md).
- **Commit cadence.** Commit each coherent unit once the inner loop (`pnpm typecheck && pnpm lint && pnpm test`) is green, imperative subject with the plan reference; group only related changes. Never commit yellow code; `--no-verify` is forbidden. End a session with `git status` clean or the pending work noted.
- **Clean up at every stage** (plan step, commit, test/netgate/showcase run, session end). Stop the processes this session started (never the user's Chrome) and check free RAM, always before a recording. Scratch lives in the scratchpad and is deleted when its stage ends; remove a merged, clean worktree (keep `netgate-baseline` / `netgate-head`); never delete committed evidence or a dirty worktree without asking. Keep `MEMORY.md` under 24 KB, one short line per note, pruned.
- **NEVER build a parallel system.** When a feature needs something the game already does, EXTEND that system; never write a sibling. Before a plan is presented or built, a hostile reviewer agent (plan + codebase, not your conclusion) names the existing system for each new piece; a duplicate is a blocker. If a sibling seems necessary, ask the owner with AskUserQuestion BEFORE any code. Subagent briefs say: "extend existing systems; if a new parallel one seems needed, stop and report".
- **End every message with a status line:** **Continuing:**, **Done:** or **Waiting on you:**. Never end a turn to wait for "continue": execute ALL of an approved plan (commit, push, PR with auto-merge, next piece); stop only when done, for a genuine user decision or a hard blocker; a phase boundary, an in-flight PR or the size of what is left is not a reason. Pending CI is no reason to stop: start the next independent item. Decisions go through AskUserQuestion, never prose questions.
- **Push and open PRs.** Never leave finished, green work unpushed. Branch from fresh `origin/main`; merge `origin/main` once before the first push, then only on a conflict (`DIRTY`) or for needed code, with `git merge`, never rebase. Enable auto-merge (`gh pr merge <n> --auto --merge`) the instant the PR exists and report "auto-merge on".
- **Rules live in the repo.** Auto-memory is per machine (the user has two): only machine-specific facts go there; rules, conventions and gotchas go in the repo.
- **Work in a worktree** (`.claude/worktrees/<name>`, own branch), never the main checkout. Check a port's owner right before using it; stop only processes this session started (worktree path in the command line); another session's server is never yours: use an offset lane (`EQX_E2E_PORT_OFFSET`, `EQX_SHOWCASE_PORT_OFFSET`, `NETGATE_PORT_OFFSET`).
- **Verify server changes.** `timeout 8 pnpm dev:server` must print `EQX Peri server started` and exit 143; anything else broke the runtime even if typecheck passes.

## Running E2E Tests and the test-harness philosophy

**Before running, writing or fixing any E2E spec, read [e2e-framework](docs/architecture/e2e-framework.md) "Running E2E specs" and "Bespoke gameplay triggers".** Triage a red spec with `.claude/skills/e2e-triage/SKILL.md`.
- A flood of `boot.spec.ts` timeouts means a stale server of yours: stop it and boot fresh; keep `reuseExistingServer: true`, use `CI=1` for diagnostic loops.
- Announce expected duration and Bash timeout first, never invented clock times; timeout = expected + ~30–50 %, max 10 min. Narrow first; the full suite only in the background into a log.
- Inner loop: typecheck + lint + unit + server boot; targeted E2E is the outer loop. Measurement specs live in `tests/perf/`. Keep `featureTriggers.mjs` current; never hard-code ports.
- Target 1–2 s per test. A game-time wait gets a bespoke trigger, never a bigger timeout (only infrastructure justifies one).

## Netcode-health gate (`pnpm e2e:netgate`)

**Before running it or reading its verdict, read [.claude/skills/netgate/SKILL.md](.claude/skills/netgate/SKILL.md).** Required (#8) for a PR matching a scenario's `triggerGlobs`. Its pass/fail IS the verdict: never predict from `git diff`, never widen a margin, never measure with `?diag=1`, never in the inner loop. A precondition failure is not "healthy"; a failure that survives CI's one retry is a real regression, never a host flake.

## Showcase video (`pnpm showcase`) — a feature adds a shot

**Before filming or reviewing a clip, read [showcase-pipeline](docs/architecture/showcase-pipeline.md) "Filming and review rules".** A new player-facing feature ships a shot or a reasoned `SHOWCASE_EXEMPT`/`SHOWCASE_PENDING` entry (a docs page uses `<!-- showcase-exempt: <reason> -->`). Record the game as it is: never hide UI, re-stage or change behaviour for a clip; full HUD, player's look. A hostile reviewer checks every clip before the user sees it. Look R&D happens in the game behind a flag, never in a parallel renderer.

## Perf scenes (`pnpm perf:scenes`)

**Before running a perf A/B or adding a scene, read [perf-scenes](docs/architecture/perf-scenes.md).** Claude runs it, not the user, before a PR touching rendering, the server tick, the snapshot path or combat at scale; the verdict table goes in the PR body. Percentiles and hitches, never mean FPS; INVALID is never fast, INCONCLUSIVE never a pass. Never ask the user to run phone tests.
