# CLAUDE.md — EQX Peri (Root)

You are working in **EQX Peri**, a multiplayer space game. This file is your north star; read it before making any non-trivial change. Zone-specific rules live in:

- [src/core/CLAUDE.md](src/core/CLAUDE.md)
- [src/server/CLAUDE.md](src/server/CLAUDE.md)
- [src/client/CLAUDE.md](src/client/CLAUDE.md)

Non-obvious lessons learned during implementation go in [docs/LESSONS.md](docs/LESSONS.md).

The Master Architecture Blueprint is the authoritative design document; the approved phased plan file (under `C:\Users\alecv\.claude\plans\`) is the executable roadmap. When the blueprint and a zone CLAUDE.md appear to disagree, the most recently-updated CLAUDE.md wins (it reflects what was actually learned while building).

---

## Cross-Phase Invariants (ALL must hold at every phase gate)

1. **Boundary integrity.** `src/core` imports no client or server library. `src/server` imports no client library. `src/client` imports no server-only package or Node-only API. CI-enforced via `eslint-plugin-import` `no-restricted-imports`. The canary fixture at [src/core/\_\_fixtures\_\_/leak.ts.disabled](src/core/__fixtures__/leak.ts.disabled) exists to prove this enforcement is live; toggling its extension must break CI.
2. **Zustand purity.** No spatial field (`x`, `y`, `vx`, `vy`, `angle`, `rotation`, `position`, `velocity`) may appear in the Zustand store. Lint rule in `eslint.config.js` blocks it. Spatial state lives in the render mirror polled by Pixi; UI state lives in Zustand.
3. **Network validation.** Every inbound server message has a zod schema. Malformed packets are dropped with a sampled `pino.warn` — they never reach game logic.
4. **Fixed timestep.** `world.step(1/60)` inside a `while (accumulator >= fixedDt)` catch-up loop. No variable-dt physics anywhere.
5. **DI seams.** `src/core` never constructs a renderer / audio / network sink / persistence. Implementations are injected by the appropriate zone at bootstrap via the contracts in `src/core/contracts/`.
6. **SOLID adherence** (see below). Enforced at code-review time.
7. **CLAUDE.md currency.** Every PR that changes an invariant, adds a contract, introduces a threshold, or teaches a non-obvious lesson updates the relevant CLAUDE.md file in the same PR. If you find yourself about to merge without updating CLAUDE.md, stop and ask whether this PR is actually teaching something.
8. **Green bars before done.** `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e && pnpm bench` all pass.
9. **Tests accompany every behavioural change.** Any PR that changes physics behaviour, prediction logic, obstacle sync, or collision handling MUST include a new or updated E2E test in `tests/e2e/` that would have caught the regression. "I manually verified it works" is not sufficient — manual checks are not repeatable and do not protect future PRs. If no test is added, the PR is incomplete.
10. **Documentation as a shipped artefact.** Every major feature ships with at least one prose guide under `docs/features/` (player-facing behaviour) or `docs/architecture/` (system internals). [`docs/LESSONS.md`](docs/LESSONS.md) captures gotchas; CLAUDE.md captures rules; `docs/` captures the *story* — the why, the migration path, the future plans. See `docs/architecture/galaxy-graph.md`, `docs/architecture/persistence-and-migrations.md`, and `docs/architecture/ship-physics-handling.md` for examples.
11. **Ship-kind catalogue is append-only.** The single source of truth for ship types is [src/shared-types/shipKinds.ts](src/shared-types/shipKinds.ts). The catalogue's `SHIP_KINDS_LIST` order is part of the swarm wire format (drone kinds encode as a `u8` index). Adding a new kind: append a record. Removing or reordering kinds: bump `SWARM_WIRE_VERSION` and verify decoder hard-fails on the old version. See [docs/features/ship-kinds.md](docs/features/ship-kinds.md).

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

## Technology Stack Matrix

| Zone | Allowed runtime libs | Purpose |
|---|---|---|
| Root tooling | `typescript`, `vite`, `tsx`, `pnpm`, `vitest`, `@playwright/test`, `eslint` + `eslint-plugin-import`, `prettier` | Build, test, lint |
| `src/core/` | `@dimforge/rapier2d-compat`, `eventemitter3`, `zod` (types), TS stdlib. No DOM, no Node-only APIs (except `worker_threads` behind a contract). | Physics, event bus, pure logic, DI contracts |
| `src/server/` | `colyseus`, `@colyseus/schema`, `@colyseus/ws-transport`, `express`, `zod`, `better-sqlite3`, `pino` + `pino-pretty`. Optional Phase 9 (multi-VM only): `@colyseus/redis-driver`, `@colyseus/redis-presence`. | Authoritative simulation host, persistence, lag comp, backpressure, orchestration |
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
