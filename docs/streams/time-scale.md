# Stream: game-wide time scale (`stream/time-scale`)

**A parallel stream. Never open a PR for this branch, merge it, put it in a train,
cherry-pick from it or merge it into another branch.** It pulls `main` into
itself (merge, never rebase), and nothing flows back. It lands only when the
owner says so. Registered on main in #473 (SHELF.md, handoff "Parallel streams").

- Plan: `C:\Users\alecv\.claude\plans\i-d-like-you-to-deep-elephant.md` (desktop).
- Design: `docs/architecture/game-time-scale.md`, amended by the owner on
  2026-11-12:
  - the speed goes both ways (0.25×–4×);
  - game time is the default, so nothing opts in: one `GameClock`, the
    fixed-step count and the render frame's dt; the wall clock is lint-banned
    outside a real-time allowlist.
- Worktree: `.claude/worktrees/stream-time-scale`. Local port lane: offset 470
  (`EQX_E2E_PORT_OFFSET`, `EQX_SHOWCASE_PORT_OFFSET`, `NETGATE_PORT_OFFSET`).
- Checks: CI doesn't run on this branch. Run the inner loop locally after every
  slice. At phase ends that touch the live loop, start netgate by hand:
  `gh workflow run netgate.yml --ref stream/time-scale`.
- Every slice keeps the game identical at 1×.

## Last sync from main

- 2026-11-12: branched from `1513f927`.

## Steps and stopping points

Each step ends in a **stopping point (🛑)**: the inner loop is green, the work is committed and pushed, and no server, browser or test run this session started is still going. The computer can be shut down at any 🛑 and the next session resumes from the first unticked step. Between stopping points the work is mid-change: finish the step, or reset its uncommitted changes, before shutting down.

**When asked "when is the next stopping point?"**, answer with the step in progress, roughly how long it has left, and its 🛑.

| Step | What | Size | Status |
|---|---|---|---|
| 0 | Register the stream on main (#473), stream log, memory | — | ✅ 🛑 |
| 1 | Telemetry: worker dropped ticks + sim-time lateness in `tick_budget` and perf scenes | ~1 h | in progress 🛑 |
| 2a | `GameClock` (core) + server `gameTime` + lint wall (warn) | ~45 min | 🛑 |
| 2b | Migrate the directors, economy, transit and holds (`?? Date.now` defaults and their loops) | ~1 h | 🛑 |
| 2c | Migrate `SectorRoom` (46 sites) + the room's timers | ~1.5 h | 🛑 |
| 2d | Lint wall to error; integration suite green; docs | ~45 min | 🛑 (end of Phase 2) |
| 3a | Worker counts real physics steps; the room runs `scale` steps per wall tick | ~2 h | 🛑 |
| 3b | `GalaxyTimeScale` + dev override + `testTimeScale` folded in; snapshot `timeScale` keyframe | ~2 h | 🛑 |
| 3c | Integration tests at 0.5× and 2×; netgate run by hand | ~1.5 h | 🛑 (end of Phase 3) |
| 4a | Client game clock: prediction anchor + `fromTick` parity test | ~2 h | 🛑 |
| 4b | Interpolation in ticks + pose ring sized for 4× | ~1.5 h | 🛑 |
| 4c | Render frame dt at the source (Pixi ticker speed); client lint wall | ~2 h | 🛑 |
| 4d | Speed chip + E2E + "follows automatically" test; netgate at 0.7× / 2× | ~2 h | 🛑 (end of Phase 4) |
| 5a | Dynamic controller (lateness + cost, ramp, hysteresis, audit events) | ~2 h | 🛑 |
| 5b | Burn-test verification (CI/laptop perf scene); docs; ready-to-land report | ~1.5 h | 🛑 (stream done; ask the owner how to land it) |

## Phases

| # | Phase | Steps |
|---|---|---|
| 0 | Register the stream | 0 |
| 1 | Telemetry | 1 |
| 2 | `GameClock` + lint wall + migration | 2a–2d |
| 3 | Server scale + dev override | 3a–3c |
| 4 | Client: prediction, interpolation, frame dt, speed chip | 4a–4d |
| 5 | Dynamic controller | 5a–5b |

## Log

- 2026-11-12: stream started.
- 2026-11-12: step 1 done. The worker counts the ticks its catch-up cap drops
  (SAB header word 5, `WORKER_DROPPED_TICKS_IDX`; `HEADER_WORDS` 5 → 6). Each
  `tick_budget` event now carries `wallTicks` / `simTicks` / `latenessTicks` /
  `droppedTicks`, and `/dev/perf` scenes carry `simTime`. Unit 4959 ✓,
  integration 359 ✓, boot ✓.
- 2026-11-12: step 2a done. `core/clock/GameClock.ts` (continuous game time
  at 0.25–4×, `after` / `every` timers re-armed on a speed change) and the
  server's process-wide `server/time/gameTime.ts` (`gameClock`, `gameNow()`,
  over `Date.now`, so 1× is unchanged). Lint wall in `eslint.config.js`
  (warn): 74 wall-clock sites left in `src/server`, all listed by
  `npx eslint src/server` — that list is the 2b/2c to-do.
- 2026-11-12: step 2b done. Directors (drone, robot, elite, event, flagship),
  economy (trade, convoys, wallet, bounties, labs, market), transit, holds and
  the incoming registry read `gameNow()`. Their loops and spool/hop timers are
  game timers (`gameSetInterval` / `gameSetTimeout` / `gameClearTimer` in
  `server/time/gameTime.ts`). Only `SectorRoom` is left on the lint list (46).
  Note for docs: saved timestamps are now game time, which drifts from wall
  time while the speed isn't 1×. Unit 4967 ✓, integration 359 ✓ (run with
  `--maxWorkers=4`: a full run was stopped once for low memory while another
  session recorded video), boot ✓.
