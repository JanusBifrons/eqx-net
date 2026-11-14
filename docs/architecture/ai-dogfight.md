# AI pilot dogfighting: strafing a still target

How an AI pilot fights a ship that is parked or slow. The decision layer
(manoeuvres, the utility picker, the virtual pilot) is summarised in
`src/core/CLAUDE.md` ("Dogfight decision layer"); this page holds the story of
the strafing run and why each rule is there.

## The owner's rule

Against a still target an AI pilot flies strafing runs (2026-11-14): "dive in
firing, pass, swing round and come again, like a fighter on a ground target.
Always moving." No Tail, no Hold: both settle beside a stopped ship.

## Still, parked or slow: judged over a moment

`targetParked` (under `PARKED_SPEED_FRAC` 0.1 × my cruise) and `targetSlow`
(under `SLOW_SPEED_FRAC` 0.5 ×) also count a target that was under the bar
within the last `TARGET_STILL_MEMORY_S` (1 s). The brain keeps that memory per
target and fills `TacticalContext.tParkedHeld` / `tSlowHeld`.

Why: in fleet-melee take 6 the scripted pilot looked parked, but the shot's
script (`showcase/shots/fleetMelee.ts`) flies at the nearest robot whenever it
is over 220 u away and then sits facing it. So each time the Robot Orb drew off,
the pilot lurched 40–150 u at it at up to ~220 u/s for ~0.5 s and stopped.
Judged on the instant, each lurch made it a moving ship. The Orb then:

1. broke off its extend (Break: the pilot came at it from behind);
2. tailed it;
3. braked beside it as it stopped;
4. crawled into the next run ~130 u off it.

It never got past ~5 ship lengths and spent 31 % of the take inside 3.

The parked memory also means "it cannot be tailing me" (`isTailed`, the Break
gate). So it only counts once the target has sat under the parked bar for
`TARGET_STILL_MIN_S` (0.5 s). Remembered from the instant, a robot set on a
fighter's six from rest read as parked for its first second, and the fighter
turned to strafe it instead of breaking (`dogfightOnSight`). The filmed pilot
sat still ~0.7–2 s between lurches.

A ship only *remembered* as slow that is on my tail at speed now is fought as
a moving one (no strafing scores; the picker's normal rules, Break
included). Otherwise a tailer that started at half my cruise was strafed
instead of broken from for its first second (`dogfight` "breaks within 1 s").

## The run

`AttackRunManoeuvre` (`src/core/ai/tactics/manoeuvres.ts`) against a slow or
parked ship:

- **Miss.** The pass aims `STRAFE_MISS_OVERSHOOTS` (¼) ×
  `shipTuning.attackRunOvershoot` beside the target, never inside
  `STRAFE_MISS_CLEAR_MUL` (1.25) × `hullClearance`, about 160 u for a robot.
  `hullClearance` (both shield bubbles + one hull radius,
  `tactics/manoeuvre.ts`) is also the rule hull avoidance uses. Once hull
  avoidance counted shield bubbles, the old 110 u miss sat inside its 112–130 u
  clearance. Every pass became a dodge square to the closing velocity, which
  scraped round the target's bubble at 30–80 u/s for ~1 s.
- **Dive.** Until the pass locks (at the pull distance, an overshoot out at
  least), the nose sits on the lead, so the dive fires. Flown along the course
  to the wider miss, the nose sat ~13–22° off the lead, outside the ~14° fire
  cone: 1–11 hits in 30 s instead of 20–30.
- **Pass.** The heading follows the line that grazes the miss circle round
  where the target will be `STRAFE_LEAD_S` (0.5 s) on.
  - It is re-aimed when the target moves so that the line passes inside
    `STRAFE_RELOCK_FRAC` (0.9) × the miss.
  - If the ship is already inside the miss with the target still ahead, the
    pass is over and the extend starts.
  - The `RUN_PASS_MAX_S` timer only ends the pass once the ship is abeam of the
    target, capped at `RUN_STRAFE_PASS_CAP` timers. The pass locks up to an
    overshoot out (440 u for the robots), and a robot at cruise (~130 u/s,
    its boost spent down to the Break reserve) covers ~260 u in the timer, so
    the extend began short of the target.
- **Extend.** The ship flies the locked course, bent to at least
  `STRAFE_EXTEND_OUT` (60° off straight at the target, kept on its sideways
  side) until it is `STRAFE_EXTEND_OVERSHOOTS` × overshoot out. Flown
  straight, a target that moved in front of it turned the extend into a ram
  course: a Robot Cube pressed a nudging pilot's bubble at matched speed for
  3 s, and hull avoidance (relative speed ~0) never reacted. The extend may
  boost down to, not below, the 25 % Break reserve (`BOOST_RESERVE_FRAC`), as
  every manoeuvre does.
- **Swing round.** A new run that starts while still flying away swings round
  in an arc (`swingRound`).

Duels with a moving ship keep the old run unchanged: the point beside the
target, the timer, the straight extend.

## Locks

- `tests/integration/sectorRoom/strafeParkedRobots.test.ts`: a Robot Orb and a
  Robot Cube, 30 s, run on two pilots:
  - **(a) a still pilot.** Gates: ≥ 3 passes each, ≤ 10 % of samples inside
    3 own lengths, no slow stretch (< 40 % cruise) inside them over 1 s, no
    rams.
  - **(b) the shot's nudging pilot.** Same gates except passes, which are only
    logged: the pilot chases each extend.
  - **Before:** (a) inside 3 lengths 0.12–0.42; (b) 0.14–0.28, Tail and Break
    on every lurch, a ram.
  - **After:** six runs each, (a) ≤ 0.03, (b) ≤ 0.08, holds ≤ 0.4 s, 0 rams.
- `strafeParked.test.ts`: a fighter on a parked pilot.
- `tactics/manoeuvres.test.ts`: the miss floor, the grazing line, a close-in
  pass ending, the still-memory helpers.
