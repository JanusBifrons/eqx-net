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
| 2b | Migrate the directors, economy, transit and holds (`?? Date.now` defaults and their loops) | ~1 h | ✅ 🛑 |
| 2c | Migrate `SectorRoom` (46 sites) + the room's timers | ~1.5 h | ✅ 🛑 |
| 2d | Lint wall to error; integration suite green; docs | ~45 min | ✅ 🛑 (end of Phase 2) |
| 3a | Per-sector speed: each room owns a clock; room loop + its physics world run 60 × speed ticks per wall second | ~2 h | ✅ 🛑 |
| 3b | Speed override per sector (env, dev endpoint, test/showcase join option); `testTimeScale` folded in; snapshot `timeScale` keyframe | ~2 h | ✅ 🛑 |
| 3c | Integration tests at 0.5× and 2×; netgate run by hand | ~1.5 h | ✅ 🛑 (end of Phase 3) |
| 4a | Client game clock: prediction anchor + `fromTick` parity test | ~2 h | ✅ 🛑 |
| 4b | Interpolation in ticks + pose ring sized for 4× | ~1.5 h | ✅ 🛑 |
| 4c | Render frame dt at the source (Pixi ticker speed); client lint wall | ~2 h | ✅ 🛑 |
| 4d | Speed chip + E2E + "follows automatically" test; netgate at 0.7× / 2×; fold `testTimeScale` into the sector speed | ~2 h | ✅ 🛑 (end of Phase 4) |
| 5a | Dynamic controller (lateness + cost, ramp, hysteresis, audit events) | ~2 h | next 🛑 |
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
- 2026-11-12: synced main (6 commits, clean merge `53af4e97`).
- 2026-11-12: step 2c done. `SectorRoom`'s 46 sites: gameplay reads use
  `gameNow()`; the structure grid pulse and turret tick are game timers. Real
  time, marked inline: the room tick scheduler, cost measurement, the perf burn,
  perf-scene marks, and the inspector's selection-stats refresh (UI rate).
- 2026-11-12: step 2d done; **Phase 2 complete.** The wall-clock lint is an
  ERROR in core and server (0 sites outside the allowlist). Docs: design note
  §0, `src/core/CLAUDE.md`, `src/server/CLAUDE.md`. Unit 4969 ✓, integration
  360 ✓, lint 0 errors, boot ✓.
- 2026-11-12: **owner: speed is PER SECTOR** ("It's fine to be per sector…
  It will ultimately be per sector"; galaxy-wide was only meant to make it
  easier). Cross-sector world time (directors, economy, convoys, wallets,
  holds) keeps the process clock.
- 2026-11-12: step 3a done. Each `SectorRoom` owns `this.gameClock`
  (`createSectorClock()`); the room's gameplay reads, grid/turret timers,
  transit spools and research labs use it. The room loop runs 60 × speed
  updates per wall second; the physics worker keeps a schedule PER WORLD
  (`SET_TIME_SCALE`, posted on every speed change), so sectors on one worker
  can differ. Lateness telemetry counts against 60 × speed. Unit 4972 ✓,
  integration 360 ✓, boot ✓. Wall-rate checks at 0.5×/2× come in 3c
  (measured against lateness, so a busy host is INCONCLUSIVE, not a pass).
- 3b note: `testTimeScale` (per room, 10×, physics only) can now become the
  room's own speed, since speed is per sector; the 4× cap applies to the
  player-facing knob, and testMode rooms may go to 10×.
- 2026-11-12: step 3b done. `SectorRoom.setTimeScale(s)` is the one entry
  point. Ways to set it: the testMode room/join option `timeScale` (URL
  `?timeScale=`, `TestClientOpts`, harness), `EQX_TIME_SCALE` (dev) and
  `GET|POST /dev/time-scale`. Snapshots carry `timeScale: { s, fromTick }`
  while the speed isn't 1. The new test failed first on a real ordering bug: a
  speed set in `onCreate` came before the room subscribed to speed changes,
  so neither the worker nor the keyframe saw it. Fixed. `testTimeScale` fold
  moved to 4d (the client must follow the speed first). Unit 4972 ✓,
  integration 363 ✓ + 1 port collision (`EADDRINUSE :2767`, another session's
  showcase server; the file passes 3/3 alone), boot ✓.
- 2026-11-12: step 3c done; **Phase 3 complete.** Integration test: one game
  second is 60.0 ticks at 0.5× and at 2×. With the worker ignoring its speed
  the same test reads 119.2 / 30.9 and fails, so it can fail. Host-safe: 0.5×
  is an upper bound, and 2× is a lower bound that is INCONCLUSIVE if the worker
  dropped ticks. Spools run on the sector clock, so a 30 s spool is 1,800
  ticks at any speed. Netgate by hand on the branch: run 43241425594, GREEN.
  Unit 4972 ✓, integration 366 ✓, boot ✓.
- 2026-11-12: step 4a done. The client has a game clock over its injected
  clock, with its speed set from the snapshot keyframe. The tick anchor,
  `targetTick`, the render dead-reckon and the shell display tick run on game
  time. A speed change re-anchors hard on that snapshot's own `serverTick`.
  `GameClock` is exact at 1× (`now()` / `at()` return the wall value until
  the first change). Unit 4976 ✓, integration ✓.
- 2026-11-12: 4a integration run: 364 ✓, 2 ✗ under the 6-worker parallel
  run, both passing alone. `galaxyBases`: `EADDRINUSE :3087`, a port
  collision. `teleporter` "loads a pad": the test waits a fixed 150 ms wall
  for a message round trip and the loaded run took longer; it passes 3/3
  alone, and the message path doesn't touch game timers. This fragile wait was
  already on main; left as is (main's test). Also restored
  `ColyseusClient.ts` to CRLF as on main.
- 2026-11-12: step 4b done. The display-delay windows are GAME ms. Swarm:
  the adaptive delay's floor and ceiling are 100/speed and 280/speed wall ms
  (`setSwarmDisplaySpeed`). Missiles: `MISSILE_DISPLAY_DELAY_MS /
  mirror.timeScale`. Arrival stamps stay wall: interpolating wall-stamped
  game-time poses already shows slow motion, and the worker renderer has no
  client clock. `POSE_RING_DEPTH` (10) needs no resize: the window is ~6
  poses at every speed, locked by `swarmInterpolation.timeScale.test.ts`.
  `RenderMirror.timeScale` (absent = 1×) carries the speed to the renderer
  (and 4c). Unit 4980 ✓.
- 2026-11-12: step 4c done. `PixiRenderer.fxNow()` is the one presentation
  clock (GameClock over `performance.now()`, speed from `mirror.timeScale`
  each frame). Every effect and animation reads it. A lint wall over
  `src/client/render/**` + `src/client/effects/**` keeps new effects on it,
  and on its first run it caught four sites (shield hits ×2, a light's t0, the
  spool fx) that would have desynced from their game-time partners. The
  incoming-fire countdown moved to game time (it is game seconds). Real time:
  wall-stamped pose interpolation, camera/UI, measurement, each marked
  inline. Lock: `FxExplosions.timeScale.test.ts`. Unit 4981 ✓, lint 0 errors.
- 2026-11-12: step 4d done; **Phase 4 complete.** HUD speed chip in the
  status capsule (amber slow / cyan fast, hidden at 1×; Zustand `timeScale`,
  reset on dispose; `data-time-scale` on `hud-status`). E2E
  `time-scale-chip.spec.ts` passes (16 s, lane 470, feature tier + trigger
  area). Netgate scenarios `speed-0.7` / `speed-2` are print-only: the
  baseline arm is main at 1×. Player page `docs/features/game-speed.md`
  (SHOWCASE_PENDING). **`testTimeScale` NOT folded** (reasons in the design
  note §0; reversible; tell the owner). Unit 4983 ✓, lint 0 errors.
