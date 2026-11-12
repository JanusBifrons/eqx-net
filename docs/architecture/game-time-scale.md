# Game-wide time scale (design note, 2026-11-12)

Status: **IN PROGRESS on the parallel stream `stream/time-scale` (owner, 2026-11-12).** Never PR, merge, train or sync from that branch; it lands only on the owner's word. This file on `main` is the starting design; the stream's copy is the live one.

**Owner decisions (2026-11-12):**
- **What it's for:** it's a **performance mechanism, not a gameplay mechanic**: "Why can't it be dynamic? It's designed as a performance thing". So the speed is **dynamic**, never a menu.
- **Speed goes both ways (amended 2026-11-12, owner: "It's supposed to be variable up or down").** One knob from 0.25× to 4×. The automatic load controller only ever slows (it recovers toward the chosen speed). Dev/admin, tests, demos and videos can set it faster or slower (today's `testTimeScale`, which only speeds up physics, folds into it).
- **Game time is the default; nothing opts in (added 2026-11-12, owner: no "time dilation flags absolutely everywhere"; new gameplay and graphics must follow it automatically).** The scale enters at the few places time enters the game: the fixed-step count, one injected `GameClock` and the render frame's dt. A lint rule bans the wall clock in gameplay and render code, with a short real-time allowlist (persistence, network, UI, diagnostics), so new code gets game time without writing anything for it.
- **Scope:** **galaxy-wide**: one speed for every sector.
- **Indicator:** shows the current speed while it isn't 1×.

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

- **One controller, process-global.** It sits beside the Living World director, off the 60 Hz loop, and reads every room's load each control tick.
- **Load signals:** tick cost (today's > 14 ms) AND **lateness**: wall time minus sim time falling behind, plus the worker's dropped ticks. Lateness is the starved-host case the shelf found.
- **Galaxy-wide speed** = what the WORST room needs. One overloaded sector slows every sector a little, by owner decision. If that proves too punishing in play, per-sector speed is the fallback, since the client anchor (§2.4) is per room anyway.
- **Smooth changes:** ramp down quickly when behind, recover slowly (today's 1 s ramp and 0.7 floor are the starting knobs), with hysteresis so the speed doesn't hunt.
- **Dev/admin override:** a testMode room option and a dev endpoint force a fixed speed (or "dynamic"). `testTimeScale` folds into it: a test that wants 10× sets the override, and it applies everywhere instead of physics only.

## 4. Across sectors

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
