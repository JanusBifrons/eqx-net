# On the shelf

Design work deliberately parked, to revisit. Each entry says what we found,
why it waits, and what doing it properly involves. Remove an entry in the PR
that picks it up.

## Friendly fire for every shot (shelved 2026-11-07)

**Today:** NPC shots pass through ships of the same allegiance
(allegiances rule 6, plan peppy-jumping-pinwheel P0). A projectile never hits
its own shooter (`ProjectilePipeline`, owner skip), and a capital turret never
fires along its own deck (the per-mount fire mask, `mountLineClear`).

**Wanted (user, 2026-11-07):** "All fire hits allies, there is no FOF
detector." A battleship's shells would hit its own escorts; a drone's bolts
would hit its squadmates.

**Why it waits:** it changes how every NPC fights:
- **Formations** need spacing that keeps escorts out of the lines of fire
  (flocking radii, capital escort stations).
- **Fire decisions** need a line-of-sight check before firing (no shot through
  a friendly), in the drone AI and every capital turret.
- **Performance:** that LOS check runs per shot candidate, so it needs the
  existing spatial grids, a budget and a bench before it ships.

## Time dilation for the whole game (shelved 2026-11-07)

**Found:** time dilation (`SimulationClock`, rate 0.7 to 1.0) engages only
when a server tick costs more than 14 ms of work. When the host starves the
server of CPU, ticks stay cheap but arrive late, and the physics worker drops
the lost time (its catch-up cap in `core/physics/worker.ts`) while still
reporting rate 1.0. Measured: a server at ~25 Hz with two browsers + Vite on
the laptop (60.0 Hz alone). The client kept wall-clock time, its lead swung
4 to 38 ticks, and every swing was a prediction correction: jitter, with one
player. The client also reads `clockRate` only for the HUD and audio pitch;
its prediction ignores it, so even a real slowdown would show as corrections,
not slow motion.

**Wanted:** an overloaded server (a big fight, many players) slows the whole
game smoothly instead of jittering.

**Why it waits:** it is not just ticks. Doing it properly changes the speed of
everything, on both sides:
- physics dt and client prediction;
- snapshot interpolation (display delay, pose buffers);
- gameplay timers: reloads, cooldowns, warp spool, the structure grid pulse,
  the turret cadence, AI timers (many are wall-clock ms, not ticks);
- presentation: effects, particles, animation, camera eases.

Estimated one to two weeks with tests. The trigger must also include lateness
(sim time falling behind wall-clock), not only tick cost.

**Small pieces that could land first:**
- Count the worker's dropped ticks in server telemetry and perf scenes, so
  starvation on a real server is visible.
- The showcase already retakes a take whose server ran below 57 Hz
  (`showcase/wobble.ts` `netProblem`).
