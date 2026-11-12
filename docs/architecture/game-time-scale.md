# Game-wide time scale (design note, 2026-11-12)

Status: **design only, nothing built.** Handoff item 4. This is the same work as the shelved "time dilation for the whole game" (`docs/SHELF.md`), so one design covers both:

- a **chosen** speed (slow motion or fast forward), shown by a speed indicator;
- an **automatic** slowdown when the server can't keep up (TiDi), which today jitters instead of slowing.

Some choices are the owner's; they are listed at the end.

## 1. What exists today

| Piece | Where | What it does |
|---|---|---|
| `SimulationClock` | `core/clock/SimulationClock.ts` | Computes a rate of 0.7–1.0 from tick COST (> 14 ms of work). It never sees lateness. |
| `CLOCK_RATE` worker command | `core/physics/worker.ts` | The worker's accumulator gains `rate × 1/60` per tick, so some ticks take 0 Rapier steps. Each step's dt is still exactly 1/60 (invariant #4 holds). |
| `testTimeScale` | `SectorRoom` (testMode) | Multiplies that same rate (10× in `test-sector-fast`). Only the worker's PHYSICS speeds up. |
| `state.clockRate` | room state → client | Used only by the HUD (`tidiSync`) and the audio pitch. Client prediction ignores it. |

So the slowdown that exists today is **physics-only and server-only**:

- **Main thread unscaled:** the room's main thread (`serverTick`, projectiles, AI, locks, the snapshot) still runs one step per tick.
- **Wall-clock timers unscaled:** about 50 wall-clock timers keep real time (grid pulse, turret 100 ms, directors' `setInterval`, spool and lock timers).
- **Client unscaled:** the client predicts at full speed.

At rate 0.7 the local ship would be corrected every snapshot. That is why the shelf entry says it shows up as jitter, not slow motion.

## 2. The model: one sim clock, fixed step, variable steps per second

**Rule: game time is counted in fixed 1/60 s steps; the time scale changes how many steps run per wall-clock second, never the size of a step.**

- **Steps per second:** `scale` 0.5 runs 30 steps a second; `scale` 2 runs 120.
- **Step size never changes:** Rapier, prediction and every closed-form path (shells' `shellPoseAt`, `stepLock`) stay exactly as they are. A step is a step.
- **Rejected: a bigger dt.** Scaling dt instead (one step of `scale/60` s) would be simpler to wire up. But it breaks invariant #4, makes fast objects tunnel at 2×, and makes client and server prediction disagree at every speed change.

Everything that measures game time must then count **steps**, not milliseconds:

1. **One clock seam.** A `SimClock` in `src/core/clock/` (the worker already keeps `tick`; the room keeps `serverTick`) with `nowTicks()` and `ticksFor(ms)`. Every gameplay timer reads it.
2. **Timer migration.** Each of the ~50 wall-clock timers falls into one of three classes:
   - **Game time:** reloads, spools, construction, the grid pulse, turret cadence, lock times, the AI's `FORGET_TICKS`, loot TTLs. These move to `SimClock`.
   - **World time:** directors, trade and convoys run across sectors. They need a decision (§4).
   - **Real time:** persistence flushes, backpressure, session takeover, audit throttles. These stay wall-clock.

   An inventory test lists every `setInterval` / `Date.now()` / `performance.now()` in `src/server` with its class, so a new one can't slip in unclassified. It is a count gate, not a timing gate.
3. **Room tick.** `update()` runs `scale` steps per wall tick. The fractional part goes through an accumulator, as the worker already does. At 2× it runs two steps per update. Snapshots stay at 20 Hz WALL time, so bandwidth doesn't change with speed; each snapshot simply spans more steps.
4. **Client prediction.** `tickPhysics` today derives `targetTick` from `(now − welcomePerfNow) / 16.67`. With a scale it becomes a piecewise anchor:

   `targetTick = anchorTick + (now − anchorPerfNow) × 60 × scale`

   The anchor is re-taken at every scale change. The scale rides the snapshot as a keyframe, `timeScale: { s, fromTick }`, emitted when not 1 (#16: a late joiner converges from the snapshot alone; the clock-rate patch is only an accelerator). Client and server must agree on `fromTick` exactly, or every speed change is a correction. That is a two-sided contract (#15) and needs a test that fails when they disagree.
5. **Interpolation.** `DISPLAY_DELAY_MS` and the pose rings are in wall ms. Converted to ticks at the current scale, they keep drawn drones/shells the same distance behind. `POSE_RING_DEPTH` must cover the delay at the FASTEST scale (at 2× twice the ticks pass in the same 100 ms; the Step-4 regression class).
6. **Presentation.** Effects, particles, engine plumes and camera eases take `dt × scale`. The audio pitch already follows `clockRate`. The UI (drawers, menus) stays real time.

## 3. Time dilation falls out of it

With §2 in place, TiDi is just an automatic `scale < 1`. Two changes from today:

- **The trigger includes lateness.** Wall time minus sim time falling behind is the starved-host case the shelf found: the worker drops time and reports 1.0. Count the worker's dropped ticks (shelf "small piece", can land first).
- **Clients see it as slow motion.** The client is told the scale like any other, so a slowdown reads as slow motion, not jitter.

The floor (0.7) and ramp stay as tuning knobs.

## 4. Scope across sectors

Each room is its own simulation, so the scale is naturally **per room**. The trouble is the processes that span rooms:

| Process | Today | Options |
|---|---|---|
| Hop/warp spools | wall ms, per room | game time of the departing room |
| Living World / robot directors | 1.5 s wall loop | (a) wall time, (b) the galaxy-wide scale, (c) each squad's current room |
| Trade / convoys | 1 s wall loop | same three |
| Alien gate timetable | wall clock, shared by both rooms | must stay one clock for both ends |

A galaxy-wide scale (one number, every room) avoids all of the cross-sector questions and is the recommended first cut. Per-sector speeds (e.g. a hot battle slowed down while the rest of the galaxy runs at 1×) can come later: the anchor in §2 is per room already.

## 5. Speed indicator

- **Where:** a small chip next to the energy capsule (hidden at 1×).
- **What it shows:** `0.5×` / `2×` for a chosen speed, and an amber `TiDi 0.8×` for an automatic slowdown.
- **Source:** the snapshot's `timeScale` (or `clockRate`). It is a discrete Zustand scalar, written on change only (#2).
- **Test hook:** `data-time-scale` on the game surface for E2E.

## 6. Phases

1. **Telemetry (small, can land now):** count dropped worker ticks and sim-time lateness in perf scenes and `/dev/events`.
2. **`SimClock` + inventory test:** every game-time timer migrated; behaviour unchanged at scale 1. The integration suite is the regression lock.
3. **Server scale:** steps per update, testMode `timeScale` room option. Integration: at 0.5× a 30 s spool takes 1,800 steps and ~60 wall seconds; at 2× it takes ~15. This retires `testTimeScale` (it becomes a real scale, applied everywhere instead of physics-only).
4. **Client:** prediction anchor + interpolation in ticks + presentation. Tests: a unit test where the anchor matches the server's `fromTick`, and the netgate at 0.5× and 2× (a new scenario).
5. **TiDi on the new path:** lateness trigger, the existing ramp.
6. **The chosen speed:** the control (owner decision below) and the indicator.

Rough size: 1–2 weeks, as the shelf estimated. Phases 2 and 4 are most of it.

## 7. Risks

- **Fast forward costs CPU in direct proportion:** 2× = twice the server work per wall second. A sector already near budget can't run 2×. Cap the chosen speed by the measured tick budget, and let TiDi win.
- **Prediction at 2× doubles the client's per-frame catch-up:** `MAX_CATCH_UP_TICKS` (4) must scale or the client falls behind on a 60 Hz phone.
- **Every wall-clock timer missed in phase 2 is a bug at any speed other than 1.** The inventory test exists for exactly this.
- **Lock times and the AI's reaction times are tuned in real seconds:** at 2× a 17 s 16" lock takes 8.5 s of the player's life. That is presumably intended for fast forward, but confirm.

## Owner decisions needed

1. **Who sets the speed:** dev/admin only, any player in a single-player sector, or a vote?
2. **The range:** e.g. 0.25×–4×, or just 0.5× / 1× / 2×?
3. **Scope:** galaxy-wide (recommended first) or per sector?
4. **TiDi:** should the automatic slowdown land with this, or stay shelved?
