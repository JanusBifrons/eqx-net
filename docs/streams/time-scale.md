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
| 5a | Dynamic controller (lateness + cost, ramp, hysteresis, audit events) | ~2 h | ✅ 🛑 |
| 5b | Burn-test verification (CI/laptop perf scene); docs; ready-to-land report | ~1.5 h | next 🛑 (stream done; ask the owner how to land it) |

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
- 2026-11-12: netgate (CI run 43251214222), GREEN. core gated: HEAD ≈
  baseline. Print-only, HEAD medians: 0.7×: snaps 88 (fewer, expected),
  corr 0.2, ahead 5.5, maxDrift 5.9 (baseline 15.9). 2×: snaps 191 (~2×,
  expected), corr 0, ahead 15 (the same RTT is twice the game ticks),
  maxDrift 34 (ships cover 2× the distance in the same delay), meanDrift
  unchanged, dropped 1.5 (2× snapshot traffic).
- 2026-11-12: synced main (35 commits, clean merge `cad7ad73`); lint wall clean
  on the new code. Unit 4999 ✓, integration 366 ✓ + 1 port collision
  (`:2767`, passes 3/3 alone).
- 2026-11-12: step 5a done. `core/clock/LoadSpeedController` (pure): once per
  telemetry window, lateness + the cost rate → a load factor in [0.7, 1].
  It slows fast to the speed the deficit implies, recovers +0.05 after 3 calm
  windows, holds in a dead band, and converges under a fixed overload (unit
  test). The room speed is chosen × factor, so a forced speed is the ceiling.
  It REPLACES the physics-only TiDi slowdown: `CLOCK_RATE` now carries only
  `testTimeScale`, and `state.clockRate` mirrors the factor (audio pitch, TiDi
  readout). Each change is an audit event `time_scale_changed` (reason
  load/forced). The lateness input is on in real sectors and opt-in for test
  rooms (`autoTimeScale`), so a contended test host doesn't slow every test
  room; the cost input is always on. Perf rooms skip it (fixed load).
  Integration: a burning sector slows its whole game and audits it; a 2×
  sector is pulled down from 2×, never above. Unit 5006 ✓, integration 369 ✓,
  boot ✓.
- 2026-11-12: step 5b docs: root invariant #20 (game time is the default, a
  speed per sector, the lint wall); SHELF entry removed so it leaves with the
  landing; the TiDi notes in the core and server CLAUDE.md say what it became;
  the design note lists what is still open. The browser burn scene can't run
  here: perf scenes only run on PR/main CI, a new workflow can't be
  dispatched from a branch, and the owner's rule keeps perf off this desktop.
  It waits for a laptop session. Full `@feature` E2E tier dispatched on the
  branch via the weekly workflow (CI run 43258183143).
- 2026-11-12: **the dimmer** (owner: "a dial like a dimmer so it transitions
  smoothly"). The room glides its clock toward chosen × load factor at
  0.5 speed units per wall second (1×→0.5× in 1 s, 1×→2× in 2 s); setup speeds
  snap; the dev endpoint glides (`&snap=1` jumps). Audit and `clockRate` follow
  the target. Client: no hard re-anchor (the game clock is continuous, the
  eased anchor absorbs small steps). Showcase QA gates server pace per GAME
  second. Integration: a smooth 1×→2× rises monotonically through >3
  intermediate samples. Unit 5008 ✓, integration 370 ✓ + 1 port collision
  (`:2585`, 3/3 alone).
- 2026-11-12: showcase takes of fleet-melee: 1× ×2 (stream) and 1× (main)
  were all flagged "encoded < 55 fps". That's the encode bug fixed in #487
  (eqx-net-22). 0.5× was flagged "server behind 30 Hz", which was a QA bug
  (fixed above). 2× passed QA (server 120.4 Hz, 0 corrections). Re-film after
  #487 merges, with a dimmer take.
- 2026-11-12: full `@feature` tier on the branch (CI 43258183143) vs a
  same-day main run (CI 43262161460). 20 failures are shared. 12 failed on the
  stream only: placement ×5, teleporter, turret-fence-hint, spectator, radar,
  ring-indicator, capital fly-by, swarm-tidi (flaky). They were mostly
  timeouts. Cause: on slow CI runners the COST path of the automatic slowdown
  fired in test rooms and slowed their whole game (timers, pulses, spools),
  where old TiDi slowed only physics. Fix: the automatic slowdown is OFF in
  test rooms unless `autoTimeScale: true`; real sectors and the
  (non-testMode) TiDi rooms keep it. swarm-tidi passed on retry: at the floor
  the room runs fewer ticks per wall second, so shedding takes longer
  (expected; noted, not retuned). Re-running the tier.
- 2026-11-12: **the showcase found two real bugs, both fixed.**
  1. Through a glide the client heard the speed only via snapshots, so it ran
     behind the server. Fix: the keyframe carries the glide target `t`, and
     both sides glide with the shared `glideToward`
     (`shared-types/timeScale.ts`, #15); the client extrapolates the server's
     speed every frame (last keyframe + time since wire arrival + RTT/2).
  2. Above 1× the client under-led the server: `leadTicks` comes from the RTT
     in wall time, but at speed s the same RTT spans s× the game ticks.
     Inputs arrived late, giving 11–17 corrections per dial take. Fix:
     `gameLeadTicks()` = leadTicks × speed, used for `targetTick`, the render
     tick phase and starvation recovery (exact at 1×).
  After both: the dial take had **0/510 snapshots corrected**, 0 pose
  corrections, and passed QA on the first take. Re-films with the #487 encode
  fix: fleet-melee 1× (0/247 corrected), 0.5× (0/299, 30 Hz wall = 60 per
  game s). The fixed 2× take never starts (at 2× from join, the fight thins
  the NPCs below the shot's setup threshold before the art bakes), so the
  dial shot's 8 s at 2× stands in for it. Unit 5025 ✓.
- 2026-11-12: hostile review #1 of the dial clip (fleet-melee based).
  Fixed:
  (1) the fight ended at ~1.6×, so the 2× part was empty. The shot now uses
      the pack-battle fight (25 drones, same `test_aggro` setup), which lasts
      through every speed.
  (2) the status capsule reflowed whenever the chip appeared or changed width;
      the chip now sits outside the capsule's flow, at a fixed width.
  (3) damage numbers didn't follow the speed (they counted render frames);
      `DamageNumberManager.update(step)` now takes the game speed per frame.
  Notes for the owner (on main, not this stream):
  - the HUD lock % refreshes at half rate and lags the world label (≤ 11
    points);
  - the lock-warning name falls back to "Ship" for one frame after a kill;
  - world labels are drawn under HUD panels;
  - key-hint text looks garbled over effects;
  - the fight often plays under the top HUD and the caption box (record as
    is, not changed).
  Re-take: 0/480 corrected, QA passed first take. Hostile review #2 running.
- 2026-11-12: the CI feature failures (9 specs, all stream shard 5, all pass
  locally, all pass on main) look like the shard partition. Adding
  time-scale-chip moved heavy specs (scrap-collision-stress throttles the CPU;
  ramming probe; mining beam) into the same single-worker shard ahead of the
  timing-sensitive ones. Traces show uniform slowness (~4 s per click) and no
  errors. Probe: throwaway branch `probe/time-scale-partition` (never
  merge; delete after) drops the spec to restore main's partition; CI run
  43274831696 alongside the stream rerun 43274788717.
- 2026-11-12: hostile review #2 (pack-battle version): the interceptor died in
  ~2 s and the spectator camera drifted off the fight, so every speed section
  showed empty space; the chip and capsule were clean. The shot now films the
  `perf-fleet-fight` scene: a sustained drone-vs-robot battle (52 → 31 → 82 →
  71 NPCs across the dial), spectated with a held camera on the battle (record
  as is: a held camera only in spectator mode). Take: 0/462 corrected, 60
  different fps, 0 stalls, QA passed. Hostile review #3 running.
