# Game-wide time scale (design note, 2026-11-12)

Status: **BUILT on the parallel stream `stream/time-scale` (2026-11-12); lands only on the owner's word.** Never PR, merge, train or sync from that branch before then. §0 says what was built; §1–§7 are the original design, with superseded parts marked.

**Still open when it lands:**
- **The burn perf scene in a real browser** (step 5b) has not run. It needs the laptop or a CI perf route, never this desktop. What stands in for it: the integration burn test (a loaded sector slows its whole game and audits it) and the netgate at 0.7× / 2×.
- **A hop between sectors at different speeds** (a player or bot warping from a 0.7× sector into a 1× one) is untested. The client re-anchors on the destination's first snapshot, so it should behave like any transit.
- **Saved timestamps drift** from wall time while a sector isn't at 1× (§0).
- **`testTimeScale` is not folded in** (§0, 4d).

**Owner decisions (2026-11-12):**
- **What it's for:** it's a **performance mechanism, not a gameplay mechanic**: "Why can't it be dynamic? It's designed as a performance thing". So the speed is **dynamic**, never a menu.
- **Speed goes both ways (amended 2026-11-12, owner: "It's supposed to be variable up or down").** One knob from 0.25× to 4×. The automatic load controller only ever slows (it recovers toward the chosen speed). Dev/admin, tests, demos and videos can set it faster or slower (today's `testTimeScale`, which only speeds up physics, folds into it).
- **Game time is the default; nothing opts in (added 2026-11-12, owner: no "time dilation flags absolutely everywhere"; new gameplay and graphics must follow it automatically).** The scale enters at the few places time enters the game: the fixed-step count, one injected `GameClock` and the render frame's dt. A lint rule bans the wall clock in gameplay and render code, with a short real-time allowlist (persistence, network, UI, diagnostics), so new code gets game time without writing anything for it.
- **Scope: per sector (amended 2026-11-12, owner: "It's fine to be per sector… It will ultimately be per sector").** Each sector has its own speed. Cross-sector processes (directors, economy, convoys) keep the process clock, which stays at 1× unless forced.
- **Indicator:** shows the current speed while it isn't 1×.

## 0. Built so far (stream log: `docs/streams/time-scale.md`)

- **Telemetry (step 1).** Two counters:
  - The physics worker counts the ticks its catch-up cap drops (SAB header word 5, `WORKER_DROPPED_TICKS_IDX`).
  - Every `tick_budget` event reports `wallTicks` / `simTicks` / `latenessTicks` / `droppedTicks`, the room's game time against wall time over that window. Perf scenes report the same as `simTime`.
- **Per-sector speed (step 3a).** Each `SectorRoom` owns its own `GameClock` (`createSectorClock()`): the room's gameplay reads, its structure grid and turret timers, its transit spools and research labs follow that sector's speed. The room's tick loop runs 60 × speed updates per wall second (`tickPeriodMs`), and its physics world does the same: the worker keeps a schedule PER WORLD (`SET_TIME_SCALE`, sent on every speed change), so sectors sharing one worker can run at different speeds. Each tick is still one fixed 1/60 s step (invariant #4). Per-update systems, including the snapshot cadence, follow the speed with no code of their own. Lateness telemetry counts against 60 × speed.
- **Speed override and keyframe (step 3b).** `SectorRoom.setTimeScale(s)` (clamped 0.25–4) is the one entry point: testMode room option / join option `timeScale` (URL `?timeScale=`), `EQX_TIME_SCALE` (every sector, dev only), and `GET|POST /dev/time-scale`. While a sector's speed isn't 1, every snapshot carries `timeScale: { s, fromTick }` (a shared object, emitted only when non-default, #16). `fromTick` is the room's `serverTick` when the change was applied; making it exact against the worker's first scaled tick is step 4a's parity work. `testTimeScale` (per room, 10×, physics only) stays a separate test accelerator until the client follows the speed (folded in at 4d).
- **Client prediction follows the speed (step 4a).** `ColyseusClient.gameClock` (over the injected clock) takes its speed from the snapshot keyframe; the clock anchor, `targetTick`, the render dead-reckon and the shell display tick all read it, so the client predicts 60 ticks per GAME second like the server. A speed change re-anchors hard on that snapshot's own `serverTick` (no `fromTick` arithmetic needed: the ticks before it already ran at the new speed). Networking, stalls and RTT stay wall time. At 1× the game clock is the wall clock exactly.
- **Display delays and presentation (steps 4b–4c).** The interpolation windows are GAME ms (swarm 100/speed .. 280/speed wall ms, missiles 100/speed), so the pose ring covers ~6 poses at every speed. `RenderMirror.timeScale` carries the speed to the renderer; `PixiRenderer.fxNow()` is the one presentation clock every effect reads, and a lint wall over `src/client/render/**` + `src/client/effects/**` keeps new effects on it. The wall made itself useful at once: it caught four effect sites (shield hits, a light's start time, the spool effect) whose partners were already on game time.
- **The speed chip and checks (step 4d).**
  - **The chip.** A chip in the HUD status capsule shows the speed while it isn't 1×: amber when slow, cyan when fast. Its value is a discrete Zustand `timeScale`, written on change and reset on client dispose. `data-time-scale` sits on `hud-status`. Player page: [docs/features/game-speed.md](../features/game-speed.md).
  - **Checks.** E2E `time-scale-chip.spec.ts` (feature tier; trigger area "game time scale"). Netgate scenarios `speed-0.7` / `speed-2` are PRINT-ONLY: the baseline arm is `origin/main`, which ignores `timeScale` and runs at 1×, so a relative gate would compare different speeds.
  - **`testTimeScale` is NOT folded in (decision 2026-11-12).** It stays the per-room, physics-only test accelerator (10×). Folding it would run all gameplay in 26 E2E specs at 10× (AI, timers, snapshots at 200 Hz) and change what each tests, and the 4× cap would have to lift for test rooms. It was a simplification, not a requirement, and it is reversible.
- **The dimmer (2026-11-12, owner: "a dial like a dimmer so it transitions smoothly faster or slower").** The room glides its clock toward the target speed (chosen × load factor) at `TIME_SCALE_SLEW_PER_S` = 0.5 speed units per wall second: 1× → 0.5× in 1 s, 1× → 2× in 2 s. That covers the automatic slowdown and the dev endpoint (`&snap=1` jumps). Setup speeds (room/join option, env) still apply at once.
  - **Audit:** events record target changes, not each step; `state.clockRate` mirrors the target load factor.
  - **Client:** it follows each step through the keyframe on its eased anchor path. The earlier hard re-anchor is gone, since the game clock is continuous across a change.
  - **Showcase QA** gates the server pace in ticks per GAME second, so a 0.5× take (30 ticks a wall second) passes.
- **Game time is the default on the server (steps 2a–2d).**
  - **The clock.** `GameClock` (`src/core/clock/GameClock.ts`) is continuous game time at 0.25–4× real time. Its `after` / `every` timers are re-armed when the speed changes. The server has ONE per process (`src/server/time/gameTime.ts`: `gameClock`, `gameNow()`, `gameSetTimeout` / `gameSetInterval` / `gameClearTimer`), built over `Date.now`, so at 1× every value is exactly the old one.
  - **What uses it.** Every gameplay read and timer in `src/server` and `src/core` uses it: the room, the structure grid and turret ticks, break-ins, gates, walls, teleporters, the directors, the economy, transit and holds.
  - **The lint wall.** `eslint.config.js` makes `Date.now`, `performance.now`, `setTimeout` and `setInterval` an ERROR in core and server outside a named real-time allowlist. The allowlist covers: the clocks and tick schedulers, cost measurement, persistence, networking, auth/identity, logs, process boot and client RTT. A one-off real-time line inside a gameplay file carries an inline `eslint-disable-next-line … -- real time: <why>`.
  - **Result.** A new feature written the obvious way follows the speed with no code of its own.
- **Saved timestamps are game time.** Economy deals, holds, wallets and bounties now stamp game time, which drifts from wall time while the speed isn't 1×. After a restart the clock re-anchors to wall time, so a long slowdown shifts saved deadlines by the accumulated drift. This is accepted while the automatic slowdown has a 0.7 floor; revisit if a long forced slow-motion is ever used in live play.

## 1. What exists today

| Piece | Where | What it does |
|---|---|---|
| `SimulationClock` | `core/clock/SimulationClock.ts` | Computes a rate of 0.7–1.0 from tick COST (> 14 ms of work), per room. It never sees lateness. |
| `CLOCK_RATE` worker command | `core/physics/worker.ts` | The worker's accumulator gains `rate × 1/60` per tick, so some ticks take 0 Rapier steps. Each step's dt is still exactly 1/60 (invariant #4 holds). |
| `testTimeScale` | `SectorRoom` (testMode) | Multiplies that same rate (10× in `test-sector-fast`). Only the worker's PHYSICS speeds up. |
| `state.clockRate` | room state → client | Used only by the HUD (`tidiSync`) and the audio pitch. Client prediction ignores it. |

So the slowdown that exists today is **physics-only and server-only**:

- **Main thread unscaled:** the room's main thread (`serverTick`, projectiles, AI, locks, the snapshot) still runs one step per tick.
- **Wall-clock timers unscaled:** about 50 wall-clock timers keep real time (grid pulse, turret 100 ms, directors' `setInterval`, spool and lock timers).
- **Client unscaled:** the client predicts at full speed.

At rate 0.7 the local ship would be corrected every snapshot, so it shows up as jitter, not slow motion. Worse, the common overload never triggers it: a starved host delivers ticks late but cheap, and the worker drops the lost time while still reporting 1.0 (shelf entry).

## 2. The model: one sim clock, fixed step, fewer steps per second

**Rule: game time is counted in fixed 1/60 s steps; the time scale changes how many steps run per wall-clock second, never the size of a step.**

- **Steps per second:** scale 0.7 runs 42 steps a wall second.
- **Step size never changes:** Rapier, prediction and every closed-form path (shells' `shellPoseAt`, `stepLock`) stay exactly as they are.
- **The goal is cheaper wall time.** Slowing down is exactly what relieves load: fewer steps per wall second is less CPU per wall second.

Everything that measures game time must then count **steps**, not milliseconds:

1. **One clock seam.** A `SimClock` in `src/core/clock/` (the worker already keeps `tick`; the room keeps `serverTick`) with `nowTicks()` and `ticksFor(ms)`. Every gameplay timer reads it.
2. **Timer migration.** Each of the ~50 wall-clock timers falls into one of three classes:
   - **Game time:** reloads, spools, construction, the grid pulse, turret cadence, lock times, the AI's `FORGET_TICKS`, loot TTLs. These move to `SimClock`.
   - **World time:** directors, trade and convoys. These also follow the galaxy-wide scale (§4).
   - **Real time:** persistence flushes, backpressure, session takeover, audit throttles. These stay wall-clock.

   An inventory test lists every `setInterval` / `Date.now()` / `performance.now()` in `src/server` with its class, so a new one can't slip in unclassified. It is a count gate, not a timing gate.
3. **Room tick.** `update()` runs `scale` steps per wall tick. The fractional part goes through an accumulator, as the worker already does. Snapshots stay at 20 Hz WALL time, so bandwidth falls with the step count rather than rising.
4. **Client prediction.** `tickPhysics` today derives `targetTick` from `(now − welcomePerfNow) / 16.67`. With a scale it becomes a piecewise anchor:

   `targetTick = anchorTick + (now − anchorPerfNow) × 60 × scale`

   The anchor is re-taken at every scale change. The scale rides the snapshot as a keyframe, `timeScale: { s, fromTick }`, emitted when not 1 (#16: a late joiner converges from the snapshot alone; the clock-rate patch is only an accelerator). Client and server must agree on `fromTick` exactly, or every speed change is a correction. That is a two-sided contract (#15) and needs a test that fails when they disagree.
5. **Interpolation.** `DISPLAY_DELAY_MS` and the pose rings are in wall ms. Converted to ticks at the current scale, they keep drawn drones/shells the same distance behind. Since the scale is ≤ 1, `POSE_RING_DEPTH` (sized at 1×) already covers it.
6. **Presentation.** Effects, particles, engine plumes and camera eases take `dt × scale`, so the whole picture slows together. The audio pitch already follows `clockRate`. The UI (drawers, menus) stays real time.

## 3. Deciding the speed (dynamic)

> **Scope superseded (2026-11-12):** speed is now PER SECTOR, so the controller sets each sector's speed from that sector's own load; "galaxy-wide" below is the original design.

- **One controller, process-global.** It sits beside the Living World director, off the 60 Hz loop, and reads every room's load each control tick.
- **Load signals:** tick cost (today's > 14 ms) AND **lateness**: wall time minus sim time falling behind, plus the worker's dropped ticks. Lateness is the starved-host case the shelf found.
- **Galaxy-wide speed** = what the WORST room needs. One overloaded sector slows every sector a little, by owner decision. If that proves too punishing in play, per-sector speed is the fallback, since the client anchor (§2.4) is per room anyway.
- **Smooth changes:** ramp down quickly when behind, recover slowly (today's 1 s ramp and 0.7 floor are the starting knobs), with hysteresis so the speed doesn't hunt.
- **Dev/admin override:** a testMode room option and a dev endpoint force a fixed speed (or "dynamic"). `testTimeScale` folds into it: a test that wants 10× sets the override, and it applies everywhere instead of physics only.

## 4. Across sectors

> **Superseded (2026-11-12):** with per-sector speed, cross-sector processes keep the process clock (1× unless forced). A hop between sectors of different speeds is the open question for Phase 5.

With one galaxy-wide speed, the processes that span rooms all follow it:

| Process | Today | With the scale |
|---|---|---|
| Hop/warp spools | wall ms, per room | game time (galaxy speed) |
| Living World / robot directors | 1.5 s wall loop | the loop's period scales with the galaxy speed |
| Trade / convoys | 1 s wall loop | same |
| Alien gate timetable | wall clock, shared by both rooms | galaxy game time, still one clock for both ends |

## 5. Speed indicator

- **Where:** a small chip next to the energy capsule, hidden at 1×.
- **What it shows:** e.g. `0.8×` in amber, so a player knows the slowdown is the server, not their connection.
- **Source:** the snapshot's `timeScale`. It is a discrete Zustand scalar, written on change only (#2).
- **Test hook:** `data-time-scale` on the game surface for E2E.

## 6. Phases

1. **Telemetry (small, can land now):** count dropped worker ticks and sim-time lateness in perf scenes and `/dev/events`, so overload on a real server is visible before anything reacts to it.
2. **`SimClock` + inventory test:** every game-time timer migrated; behaviour unchanged at scale 1. The integration suite is the regression lock.
3. **Server scale with the dev override:** steps per update everywhere. Integration: at 0.5× a 30 s spool takes 1,800 steps and ~60 wall seconds.
4. **Client:** prediction anchor + interpolation in ticks + presentation + the indicator. Tests: a unit test where the anchor matches the server's `fromTick`, and the netgate with a forced 0.7× (a new scenario).
5. **The dynamic controller:** galaxy-wide, lateness + cost, ramp and hysteresis. Verified with the perf scenes' `--inject-server-burn`: a burned room must slow the galaxy smoothly, with no correction spike on the client.

Rough size: 1–2 weeks, as the shelf estimated. Phases 2 and 4 are most of it.

## 7. Risks

- **Every wall-clock timer missed in phase 2 is a bug whenever the speed isn't 1.** The inventory test exists for exactly this.
- **One busy sector slows everyone.** That is the galaxy-wide decision; measure how often it triggers on the real server before tuning the floor.
- **A slowdown that never recovers** (a leak, a stuck room) would leave the galaxy slow. Log every speed change (audit event) and keep the 0.7 floor until there is data.
