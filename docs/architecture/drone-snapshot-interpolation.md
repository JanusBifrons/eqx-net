# Drone Snapshot Interpolation (the 2026-05-18 pivot)

> **Status:** shipped on `feat/drone-snapshot-interpolation`. Supersedes the
> client-side drone AI re-sim / lockstep architecture documented in
> [`ai-lockstep.md`](ai-lockstep.md) and [`reconciler-replay-scaling.md`](reconciler-replay-scaling.md)
> **for drones**. Those docs remain accurate for the *player* prediction
> path; their drone sections are historical.

## Why

Inside a ~25-drone hostile pack on mobile, combat rubberbanded 50–400 u per
snapshot while the server was healthy (diag `2026-05-18T15-53-55-jh6tf6`).
Root cause was **architectural, not tuning**: the client re-simulated drone
AI in lockstep with the server, which is intrinsically O(ticksAhead × N).
The `DRONE_RESIM_BUDGET` k-cap then dead-reckoned the ~13 maneuvering
hostiles it could not afford to re-sim → those snapped every snapshot.
Every mitigation (Option A radius cull, in-pack k-cap, bulk-gap smoothing)
traded one unbounded quantity for another. The only drone-fidelity lock,
`feel-test-lockstep.spec.ts`, used a **10-drone** room; the bug needs
**> 12** — the canary was structurally blind to the bug's regime (a genuine
invariant-#13 miss).

## What

Drones were pivoted to **pure snapshot interpolation** — the
Quake / Source / Overwatch / Gaffer "render the past" standard, the same
model asteroids and remote players already used. The client drone brain is
**retired entirely**:

- No client `AiController.tick`/`tickOnly` for drones; no
  `HostileDroneBehaviour` re-sim; no `partitionDronesByRelevance` /
  `DRONE_RESIM_BUDGET` / `droneRelevance.ts`.
- No `Reconciler` drone replay-seed (`reconcile`'s 6th param removed); the
  per-replay-tick hook now does **only** `applyRemoteInputs()`
  (remote-*player* forward-prediction is untouched).
- `_aiController` survives as a **hostility ledger only** —
  `markHostile` / `purgeHostility` / `isEntityHostileToPlayer` (HaloRadar
  threat colour, fed by `damage` / `bot_aggro`); its brain is never ticked.
- Drone pose renders via `interpolateSwarmPose` (the existing
  display-delay interpolator) off the decoder-fed `poseRing`, exactly like
  asteroids. The `PixiRenderer` `kind===1` bypass is gone.
- The predWorld drone body is kept (collidable-entity invariant). It was
  first a **kinematic follower** of the interpolated pose; since
  2026-11-08 it follows the remote-entity anchor instead (next section).

No client brain ⇒ no divergent inputs ⇒ nothing to snap. The interpolation
delay is a deliberate, tunable, standard cheat.

## One paradigm for every remote moving entity (2026-11-08)

> **All remote moving entities (players, drones, scrap): predWorld
> collision runs on the predicted timeline from the latest server state;
> rendering is per entity type.**

**Why it changed.** The local ship is predicted AHEAD of the server
(`inputTick ≈ serverTick + leadTicks`). The kinematic follower re-posed
each drone body every frame to the DISPLAY-DELAYED pose (now − 100 ms). So
in predWorld the local ship met each drone where it was ~(100 ms + lead)
ago, the server resolved the same contact against the drone's real pose,
and the next snapshot corrected the ship. The replay couldn't help: it
re-ran against the same lagging bodies. The showcase `pack-battle` shot
saw 4–14 corrections per take (gate: 2); the deterministic model
(`tests/scenarios/meleeDroneContactPrediction.test.ts`) 7 corrections,
16 u peak. See `docs/LESSONS.md` 2026-11-08.

**What it is now — the same path remote player ships always used.**

1. **Anchor.** On every snapshot, `preResetRemoteShips`
   (`src/client/net/snapshotRemoteSync.ts`) resets remote ships to
   `snap.states` and, in the same step, every drone/scrap body to its
   latest authoritative state at `snap.serverTick`
   (`anchorRemoteSwarmBodies`). The state is read off the decoder-fed pose
   ring (never `entry.x/y`, which `updateMirror` overwrites with the drawn
   pose); `authoritativeSwarmStateAt` carries the nearest ring pose to the
   anchor tick when the 60 Hz binary wire and the 20 Hz snapshot don't
   coincide (capped at 12 ticks). Velocity and angular velocity come with
   it, as they do for remote ships.
2. **Step.** The reconcile replay and every `tickPhysics` tick step all
   bodies forward together, so drones and scrap sit on the local
   prediction's timeline. Remote ships also get their `lastInput` applied;
   drones/scrap have no inputs on the wire and coast (client drone damping
   is 0, scrap keeps its server damping).
3. **Nothing re-poses them per frame.** So a contact the local ship makes
   pushes the drone/scrap body and the push stays until the next anchor —
   as on the server. (The prototype that re-posed a dead-reckoned body
   every frame left ~1–2 u of correction per contact for exactly this
   reason; the unified path takes the model's peak to ~0.06 u.)
4. **Rendering is per type.** Remote ships draw predWorld + a decaying lerp
   offset; drones/scrap draw the display-delayed interpolated pose (the
   one-pose-per-frame rule below is unchanged). A drone's collision body
   therefore LEADS its sprite by ~(100 ms + lead)·speed.
5. **Local rays test the drawn pose.** The local turrets aim at the drawn
   pose (`buildLocalAimTargets`), and the server aims its own copy of the
   mounts at the real drone. So the local beam end and the optimistic hit
   prediction use `DisplayPoseHitscan` (`src/client/combat/displayPoseHitscan.ts`):
   predWorld for everything else, drones/scrap skipped there and tested at
   the drawn `entry.x/y/angle` with their collider shapes (shield circle,
   hull once the shield is down, scrap component polygon). The beam keeps
   ending on the sprite; the server stays hit-authoritative.

Spawn: a new drone/scrap body is seeded with its latest server state
(velocity included) by `syncSwarmIntoPredWorld`; the next snapshot anchors
it. Teleports and large jumps need no guard on the body: each anchor is a
plain reset to server state. Shield-collider swaps (`setHullExposed`) keep
the body's pose and velocity. Scrap stays an unlocked dynamic mass-1 body
(locking it was the 2026-06-14 correction spike).

Locks: `tests/scenarios/meleeDroneContactPrediction.test.ts` (production
anchor within the pose gate for drones and scrap; the retired follower as
the contrast), `src/client/net/snapshotRemoteSync.remoteEntityAnchor.test.ts`
(anchor source, tick alignment, remote-ship regression lock),
`src/client/combat/displayPoseHitscan.test.ts`,
`src/client/net/remoteEntityAnchor.heapDelta.test.ts`.

## One pose per frame, one `now` — the rule, actually enforced (2026-05-19)

The pivot's design says the drone pose is "computed once per frame and every
reader sees one consistent pose". For ~6 weeks that was **only a claim**:
`updateMirror` did resolve it once and write `entry.x/y/angle`, but two
consumers then called `interpolateSwarmPose` *again* at their own clock —
the `PixiRenderer` sprite at **render-now**, and `buildLocalAimTargets`
(turret/laser aim) at **tickPhysics-now** (`0e24448` introduced the latter;
directionally correct — aim the drawn pose — but it added a *third*
divergent-`now` site). `App.tsx`'s loop is `tickPhysics → updateMirror →
render`, so within one frame those three `now`s differ by a variable,
raf-jitter-amplified amount (a whole frame under the 30 Hz worker sprite
gate). The drone's collision body + laser beam used the `updateMirror`
pose while the sprite used a different one ⇒ on-device the drones
"jittered like two things fighting for their position" and the laser
"jittered between the target and where it's drawn" (HIGH-priority report,
capture `2026-05-19T12-27-31-674Z-jfagww`, 10 `raf_gap`s).

**Enforcement:** `interpolateSwarmPose` is called for a drone **exactly
once per frame, in `updateMirror`, at the frame's single `now`**. Every
other consumer reads the resolved `entry.x/y/angle` through the named seam
[`resolveDroneDisplayPose`](../../src/client/net/swarmDisplayPose.ts) and
**must never re-interpolate**. The seam is a one-liner *by design* — it
exists so the rule is greppable and unit-lockable, not because the read is
complex. `interpolateSwarmPose` itself was **not** touched (its
display-delay / teleport guard / adaptive delay, and the
`swarmInterpolation.smoothness` canary, are unchanged) — this was purely
about *who* resolves the pose and *how many times*. The decoder is also
**unchanged**: it still writes the raw authoritative `entry.x/y` and feeds
the poseRing; the once-per-frame resolve overwrites the drone `entry.x/y`
before any consumer reads it, so the proposed "decoder feeds poseRing only"
cleanup was proven unnecessary and deferred (it would have added
asteroid/HaloRadar risk for no benefit). Asteroids (`kind===0`) are the
documented exception — locked/static server-side, never the jitter
complaint, still render-now-interpolated off the poseRing with their
predWorld bodies posed from the raw decoded pose.

Accepted residual: `buildLocalAimTargets` runs in `tickPhysics`, *before*
`updateMirror`, so the aim reads the **previous** frame's resolved pose — a
constant, deterministic ≤1-frame lead-lag (the universally-accepted "render
the past"), **not** jitter. Eliminating even that would need a loop reorder
or the decoder cleanup; both perturb the delicate pivot core for ~16 ms of
aim lag and were rejected.

Locks: [tests/unit/swarmPoseConsistency.test.ts](../../tests/unit/swarmPoseConsistency.test.ts)
(per-frame pure core — RED-first) +
[tests/scenarios/droneOnePoseAcrossFrames.test.ts](../../tests/scenarios/droneOnePoseAcrossFrames.test.ts)
(across-frames App-loop-ordering boundary lock). The
host-load-sensitive [tests/e2e/feel-test-lockstep.spec.ts](../../tests/e2e/feel-test-lockstep.spec.ts)
remains a same-env smoke, not the gate.

## The wire (binary v3 unchanged)

`SWARM_WIRE_VERSION` stays **3**. Drone x/y/vx/vy/angle/angvel flow ONLY on
the 33-byte binary swarm record. `SnapshotMessage.drones[]` was **slimmed**
to a turret/shield slice — `{ id, mountAngles?, shieldDown? }` only — and
the server only emits an entry when there is mount/shield content. This cut
the JSON snapshot ~90 % in the `network-bandwidth` baseline (312 878 →
31 415 bytes for the 100-drone scenario).

### Leaving without a destroy: swept, then drawn out (2026-11-22)

A full binary snapshot that omits a drone, scrap or wreck piece removes it
from `mirror.swarm` (the decoder's sweep). Since the entity is drawn the
display delay in the past, the sweep no longer deletes a moving kind on
arrival: it stays until the drones' read point passes its newest sample
(`latestArrivalMs`), so a picked-up scrap piece or a leaving drone
vanishes at the moment the drawn timeline reaches its last pose, piloting
and off pilot alike. Bounded by the stamped-hit deadline; welcome / sector
flush clear it. Mechanism and bound:
[shell-events](shell-events.md#stamped-release-holding-for-the-drone-timeline-2026-11-22)
slice 5 (`DrawnShellTiming.linger`). Lock: `drawnShellTiming.sweep.test.ts`.

## The feel core — display delay sized to the *binary* cadence

`DISPLAY_DELAY_MS` 0 → **100 ms**. The old "0 ms aligns render with the
predWorld collision body" rationale is obsolete: the delay only affects
drawing (the collision body runs on the predicted timeline, above). 100 ms backward-buffers
the in-interest combat cadence (binary ships ~per server tick, ≈16.7 ms) so
two bracketing samples essentially always exist → a true lerp of buffered
authoritative truth, immune to wire jitter ≤ 100 ms. The adaptive delay is
sized from the **binary** drone inter-arrival EWMA × 1.5 (see "The delay
target" below; S3-3 to S5-6 used a lateness estimate instead), NOT the 20 Hz
JSON snapshot interval; `ADAPTIVE_DELAY_CEILING_MS` is 150 (it was 200, then
280 until S5-7, which pinned 4G drones at 280); extrapolation now glides angle by
`angvel·dt` instead of freezing it. `DISPLAY_DELAY_MS` is the on-device
tuning knob (start 80–110 ms).

**Ring stamps come from the server tick, not the drain time.** Binary packets
are drained once per RAF, so stamping each with its drain time put two ticks
that landed in one frame at the SAME time and left the next frame without a
sample: the lerp then ran at 0×, then 2× speed, and a cruising drone stepped
0–5 u per frame instead of an even ~2.8 u (the fleet-melee follow jitter;
the follow camera's spring smoothed its own motion, so the ship shook on
screen). The live client decodes with `stampByTick`, which stamps each packet
`swarmArrivalStampMs(tick, now)`: `tick × tickMs + offset` (tick ms = 1000/60
÷ the sector speed), where `offset` follows the least-delayed arrival at once
and drifts up toward later ones by `TICK_CLOCK_DRIFT_UP` (1 %) at most once a
frame (see "One drift per frame" below), never
stamps a packet later than it arrived, and re-seeds when an arrival is more
than `TICK_CLOCK_RESYNC_MS` (1 s) off (new room, reconnect, long stall). A
speed change keeps the newest stamp in place. Lock:
`src/client/net/swarmInterpolation.tickStamp.test.ts` (drain-time stamps step
error 3.1 u, tick stamps 0.16 u).

**Read-only tick to stamp (S5-1).** `swarmTickToStampMs(tick, now)` returns
the stamp `swarmArrivalStampMs(tick, now)` would return at that moment (same
re-seed, earlier-arrival, drift-up and S4-5 hold-freeze rules, shared through
one helper) but changes nothing: no tick clock, lateness, estimate, delay
target or hold state. It returns NaN until the tick clock is seeded by a
drone packet (callers check `Number.isNaN` and fall back). It is for streams
on the same server tick basis (missiles, shells: S5-2) to share the drone
timeline without steering it. Lock: `src/client/net/swarmTickToStamp.test.ts`.

**The delay target: binary inter-arrival EWMA × 1.5 + drop bias, capped at
150 ms (S5-7).** Each binary drone packet updates the swarm inter-arrival
EWMA (`nextSwarmBinaryEwmaMs`: the gap since the previous packet, capped at
`SWARM_INTER_ARRIVAL_SAMPLE_CAP_MS` 500, kept at `SWARM_INTER_ARRIVAL_KEEP`
0.85; a frame-stall backlog packet, S5-1b, leaves it alone). Each applied JSON
snapshot, in `applySnapshotPerfStats`, sets the target to
`EWMA × ADAPTIVE_DELAY_FACTOR (1.5) + computeInterpBiasMs(dropCount)` (16.67 ms
a dropped snapshot, up to 200), clamped to the floor and
`ADAPTIVE_DELAY_CEILING_MS` (150 game ms; both ÷ the speed). This is main's
estimator. S3-3 had replaced it with a lateness estimate (estimate + 4 ×
deviation, ceiling 280): on 4G that pinned the target at 280 and drew drones,
missiles and shells ~300 ms late (main ~125). The lateness estimate is gone;
per-packet lateness is still counted as telemetry. On a good link the EWMA is
~16.7 ms and the target is the 100 ms floor every frame (`lan-clean`: poses
as a pinned 100 ms delay). `setSwarmDisplayDelayMs` is a test hook: it PINS
the target (the feed leaves it alone) until the next reset. Missiles read this
target (`getSwarmDisplayDelayTargetMs`) and shells the steady delay
(`getSwarmSteadyDisplayDelayMs`), so both are capped too. Locks:
`src/client/net/swarmDelayTarget.test.ts`,
`tests/unit/snapshotPerfStats.intervalMs.test.ts`; fixtures:
`tests/scenarios/gapSmoothing.drones.test.ts`,
`tests/scenarios/gapSmoothing.4gDelayCap.test.ts` (seeded 4G: drone lateness
p50 299 → ~130 ms; clean sparse stream: 0 holds, 0 re-syncs).

**The display delay is slewed.** The target (above; or
`setSwarmDisplayDelayMs` in tests) is clamped to the game-ms floor and ceiling
÷ the speed, as before; the value
the reads use glides toward it in `stepSwarmDisplayDelay(frameMs, nowMs)`, called
once per frame at the top of `updateSwarmMirror` on the frame's wall ms (`nowMs`
feeds the stream-stall hold, S4-5, below). Each frame
closes `1 − exp(−frameMs / τ)` of the gap (`DISPLAY_DELAY_SLEW_TAU_MS` 300 game
ms, ÷ the speed like the floor and ceiling), bounded to
`DISPLAY_DELAY_SLEW_MAX_RATE` (0.1) × the frame's wall ms either way,
so the read point keeps moving forward at 0.9–1.1× real time and a delay change
never jumps, stops or reverses drones (100 → 150 ms takes ≥ 0.5 s). The first
target after a reset places the value at it; on a good link the target is
the 100 ms floor and the value equals it, so nothing changes there. A speed
change re-clamps the target and clamps the value into the new range at once.
`resetSwarmTickClock` and `resetPredictionState` (sector change) put it back at
the floor via `resetSwarmDisplayDelay`, which also clears the test pin. Lock:
`src/client/net/swarmDisplayDelaySlew.test.ts`; fixtures:
`tests/scenarios/gapSmoothing.drones.test.ts`.

**The glide past the newest pose is 250 game ms (S4-1).** When the read point
runs past the newest pose (a packet gap), `interpolateSwarmPose` dead-reckons
from that pose with its `vx/vy` and `angvel` for at most
`EXTRAPOLATION_LIMIT_MS` (250 game ms, so 250 / speed wall ms, the same
convention as the delay floor and ceiling), then freezes there and counts a
glide-limit hold. It was 100 ms, so a 200 ms gap outran it and froze drones;
250 matches the missile cap (`MISSILE_EXTRAPOLATION_CAP_MS`). The glide reads
forward from the newest pose only, so a longer limit asks nothing older of the
pose ring (`POSE_RING_DEPTH` is unaffected). The velocity term is game time
(`overshoot × speed / 1000 × v`, S4-1b): `v` is per game second, so the wall
overshoot alone glided `speed`× too little at 2× and too much at 0.7× (a 60 wall
ms glide at 200 u/s moved 12 u where the drone moved 24 u at 2×, 8.4 u at
0.7×). At 1× it is bit-identical, so the 1× fixtures below are unchanged.
Effect on the fixtures: gap-400 freeze frames 12 → 3 and largest snap 47 → 12 u; gap-600 freezes 24 → 15 and
largest snap 93 → 48 u; lan-clean and gap-200 are unchanged (gap-200 was
already free of freezes under the lateness-sized delay, and stays free with
the delay pinned at the floor). Locks: `swarmInterpolation.timeScale.test.ts`
(the limit and the glide distance at 0.7× and 2×), `gapSmoothing.drones.test.ts`.

**The stream's newest stamp (S4-2).** Each tick-stamped drone packet also
records one number for the stream as a whole: the `swarmArrivalStampMs` stamp
of the newest server tick seen (`noteSwarmStreamStamp` from the decoder, read
with `getSwarmStreamNewestStampMs`, NaN after a reset). The newer tick wins, so
a reordered or late packet never moves it back. Each applied JSON snapshot
also feeds it (`noteSwarmJsonSnapshotTick`: its tick on the same clock via
`swarmTickToStampMs`, S5-7), so the stream counts as stalled only when BOTH
connections are quiet: a sparse swarm stream (the delta encoder sends nothing
while drones idle) no longer holds or re-syncs (clean link: 528 hold frames
and 24 re-syncs a minute → 0). `resetSwarmDisplayDelay` clears it. The S4-5 hold (below) reads it to tell a stalled stream from one
drone missing from a packet. Lock:
`src/client/net/swarmStreamNewestStamp.test.ts`.

**The maximum total delay and the counted re-sync (S4-4).** During a stream
stall the S4 hold will let the display delay grow so playback keeps its place
and resumes from there. That growth is bounded by `MAX_TOTAL_DISPLAY_DELAY_MS`
(400 game ms, so 400 / speed wall ms, the same convention as the floor and
ceiling; owner decision D2: 400 after a dropout; the steady ceiling is 150
since S5-7, 280 before). A stall that would
push the delay further (a gap over ~0.75 s, an idle sector resuming, a
backgrounded tab) re-syncs instead: `boundSwarmHoldDelayMs(requested, target,
speed)` returns the request while it is at or under the bound and the target
past it (a non-finite request re-syncs too). It is pure and allocation-free;
the caller checks `isSwarmHoldDelayOverMax` with the same inputs and calls
`noteSwarmResync()` once, read with `getSwarmResyncCount` and zeroed with the
other stream counters in `resetSwarmTickClock`. The S4-5 hold (below) calls
it. The pose ring is sized for this bound
(`tests/unit/poseRingDepth.test.ts` imports the constant). Lock:
`src/client/net/swarmMaxDelayResync.test.ts`.

**The hold bound above 1x.** A network stall is wall time. The longest one a
hold rides out is the bound plus the glide: 400 + 250 = 650 wall ms at 1x.
With a plain 400 / speed bound that shrank above 1x (2x: 200 + 125 = 325 ms),
so at 2x a 400 ms stall re-synced and drones snapped twice (gap-400: 88 u and
46 u). `swarmHoldBoundWallMs(speed)` (`swarmDelaySizing.ts`, pure) is 400 /
speed at or below 1x (exactly as before) and (400 + 250) − 250 / speed above
it (2x: 525 wall ms), so the stall a hold rides out stays 650 wall ms at any
speed above 1x. `isSwarmHoldDelayOverMax` / `boundSwarmHoldDelayMs` use it, so
drones and missiles share it; a missile's backward reconstruction limit
(`MissileMirror`) follows it too. The unthinned 28-tick pose ring spans 233
wall ms at 2x, short of that bound, so while a hold has grown the delay past
the adaptive ceiling (`ADAPTIVE_DELAY_CEILING_MS` / speed) the ring writes are
thinned to cover it, the off-pilot thinning (S5-9) reused through
`swarmRingCoverMs`. At or below 1x nothing changes (the ring already covers the
bound and no fixture row moved). 2x fixtures: gap-400 / gap-600 / burst-600
2 snaps and 1 re-sync -> 0 and 0 (max delay 275 / 475 wall ms, no read pinned
to the oldest pose); jitter-4g 8 snaps -> 0, no re-sync. 2x gap-swarm-only
still snaps once (131.55 u): the JSON stream keeps flowing, so the link counts
as alive and nothing holds (S5-7), the same at every speed. Locks:
`swarmMaxDelayResync.test.ts`, `swarmInterpolation.timeScale.test.ts`, the 2x
targets in `gapSmoothing.drones.test.ts`.

**Hold without losing the place (S4-5).** When the whole drone stream stalls,
`stepSwarmDisplayDelay` (after the slew) grows the delay so the read point
(now − delay) stays at the stream's newest stamp + the glide limit
(`EXTRAPOLATION_LIMIT_MS` ÷ speed). Drones glide to the limit and then stand
still instead of freezing and snapping; when packets return, playback resumes
from the held point and the ordinary slew alone brings the delay back to its
target (no second catch-up). The hold never shrinks the delay and never runs
the read point backwards. It is bounded by S4-4: a stall that would need more
than the hold bound (`swarmHoldBoundWallMs`, `MAX_TOTAL_DISPLAY_DELAY_MS` ÷
speed at or below 1x) re-syncs to the target in one step,
counted once per stall (an idle sector resuming, a 1 s gap). A drone missing
from packets while the stream is alive keeps the per-entity glide then hold.
While a frame holds, the tick clock does not drift its offset up for late
packets (`TICK_CLOCK_DRIFT_UP`): the stall's backlog all arrives late, and
without this ~36 backlog packets of a 600 ms stall dragged the offset ~100 ms
late and drones stepped back ~12 u on resume. Scalars only, no allocation;
`resetSwarmDisplayDelay` (so `resetPredictionState`) clears the hold, and
`getSwarmHoldFrameCount` counts held frames. At the bound the read point is 400
game ms back, which the 28-slot ring covers (asserted in
`swarmHoldResume.test.ts`). Effect on the 1× fixtures: gap-400 and gap-600
straight-drone snaps 2 → 0 and glide-limit holds 6 → 0 / 30 → 0, freeze frames
unchanged (3 and 15, within (gap − 350 ms) of frames), max delay 256 → 275 /
237 → 350 ms; lan-clean, gap-200, gap-json-only, frame-stall-250 and jitter-4g
unchanged. The turning drone still snaps once on resume (2.56 u at gap-400,
3.27 u at gap-600) because the straight-line glide misses the curve: this is
the gate for the S4b eased offset. Locks: `src/client/net/swarmHoldResume.test.ts`,
`swarmInterpolation.timeScale.test.ts` (0.7× and 2×),
`ColyseusClient.resetPredictionState.test.ts`, `gapSmoothing.drones.test.ts`
(gap-1000 and idle-resume fixtures).

**One mechanism, one record per stream (S5-5, owner decision D10 = A).** The
slew and the hold are pure functions over a small state record in
`src/client/net/displayDelayHold.ts` (`slewDisplayDelay`, `holdDisplayDelay`;
value, target, stall flag, hold and re-sync counters). Drones own one record in
`swarmInterpolation.ts` (`stepSwarmDisplayDelay` runs the two functions on it,
held on the binary stream's newest stamp); missiles own another in
`MissileMirror.ts` (`stepMissileDisplayDelay`, held on the JSON stream's
newest stamp, see `missile-simulation.md`). The two connections can stall
separately, so a JSON-only stall holds missiles and not drones and the other
way round. Change the algorithm in `displayDelayHold.ts` only. Lock:
`src/client/combat/MissileMirror.test.ts` (independence both ways).

**Frame-stall backlog does not teach the clock (S5-1b).** A main-thread
freeze delays arrival but says nothing about the network. The drone packets
that came in during it are all handled at once when the page wakes, before the
next frame step, so each looked up to a stall late: each pulled the tick-clock
offset 1 % later, the backlog's stamps crept toward the drain time and clamped
there, the first on-time packet then took the offset back at once, and the
backlog's lateness raised the delay target toward the ceiling (frame-stall-250:
one 4.71 u snap per drone, an 8 u short step on the stall frame, mean lateness
222 ms for seconds afterwards). Now a packet handled more than
`TICK_CLOCK_FRAME_STALL_MS` (50 ms, three 60 Hz frames) after the last
`stepSwarmDisplayDelay` read clock is backlog: it is stamped by tick on the
existing offset (no drift-up; an earlier arrival and a re-seed still apply, as
in the S4-5 hold) and its lateness is counted as telemetry only; since S5-7
its inter-arrival gap does not feed the delay EWMA either. Network lateness arrives between regular frame steps and keeps
both rules, so every other fixture and the capture replay are unchanged;
frame-stall-250 now plays as a clean link (0 snaps, delay held at the 100 ms
floor, every drawn step within the 2 u snap tolerance of the true step through
the stall). `swarmTickToStampMs` shares the rule. Scalars only;
`resetSwarmDisplayDelay` clears the last step clock. Locks:
`src/client/net/swarmTickClockFrameStall.test.ts`, `gapSmoothing.drones.test.ts`.

**One drift per frame.** Packets that arrive between two frames are all
handled before the next frame step, and a late burst (the end of a
swarm-only silence, a jitter spike) used to drift the tick-clock offset 1 %
per packet: a dozen late packets moved it ~12 % of their lateness in one
frame, the stamps ran late, and the first on-time packet took the offset back
at once (0.7x gap-swarm-only: the clock drifted 28.6 ms late, then a 2.8 u
back-step and a 9 u snap; 2x jitter-4g: a 40 ms reset, a 26.8 u snap). Now
only the first later-arrival drift since the last `stepSwarmDisplayDelay`
moves the offset; the rest of the burst is stamped by tick on it (an earlier
arrival and a re-seed still apply). `swarmArrivalStampMs` spends the frame's
drift; `swarmTickToStampMs` (read-only) honours a spent drift but never
spends one, so it still returns exactly what `swarmArrivalStampMs` would. Drone
lan-clean is bit-identical at 0.7x, 1x and 2x; the missile on lan-clean now
reads the drone timeline exactly (lateness 102.15 -> 102 ms, the drone's 102:
the 0.15 ms was a second same-frame drift the read-only path still took). Fixtures:
1x gap-200 snap 3.6 u -> 0; 1x jitter-4g largest snap 9.56 -> 5.27 u (4 -> 5
snaps, total 26.53 -> 19.43 u); 0.7x gap-400 / gap-swarm-only back-steps
1 -> 0; capture replay snaps 38 -> 35. At 2x the clock no longer hid the
old 200 wall ms hold limit, so 2x jitter-4g re-synced once (8 snaps, 9
freezes) until the hold bound above 1x (above) fixed it. Lock: `gapSmoothing.drones.test.ts`
(target "0.7x gap-swarm-only: zero back-steps and zero snaps").

**Ease the resume step (S4b).** The drawn pose of a drone or scrap piece is
`resolveSwarmDrawnPose` (`src/client/net/swarmResumeOffset.ts`): the
interpolated pose plus an eased offset, applied at the one pose-resolve site
(`updateSwarmMirror`). While the hold has the read point parked, each entry
keeps the pose it drew. On the first frame after the hold that is not a
re-sync (packets caught up), the offset is set to that held pose, moved on by
one frame at the bracketing sample's velocity, minus the pose the samples now
give; it then decays with `stepRemoteShipOffset` (the remote-ship springs,
position half-life `SWARM_RESUME_OFFSET_HALF_LIFE_MS` = 100 ms, angle 40 ms) on
WALL time, so it eases the same at 0.7× and 2×. A difference that
`isImplausibleJump` calls a teleport (span = read point − stall's newest
stamp, in game ms) is never eased. Only this resume case: the hold, slew,
glide limit, delay target and ring are unchanged, and missiles are S5. Drawing
only: physics and prediction read the pose ring (`authoritativeSwarmStateAt`),
never the drawn pose; aim and fire keep reading the drawn pose (V4). Cost: one
`SwarmResumeOffset` per moving entry, allocated with the entry by the decoder
(ten numbers: three springs of two, the half-life, the held pose of three;
the plan's estimate was seven), stepped only while live, the held pose written
only while a stall holds; `resetPredictionState` clears every offset. Effect:
gap-400, gap-swarm-only, gap-600 and burst-600-both-streams turning-drone
snaps 1 → 0 (2.56 / 3.27 u), mean lateness +0.1 ms; every other fixture
unchanged. A perf:scenes A/B is owed. Locks: `swarmResumeOffset.test.ts`,
`gapSmoothing.drones.test.ts`, `ColyseusClient.resetPredictionState.test.ts`.

**The packet's tick must be the tick of its poses.** The room and the physics
worker run separate 60 Hz loops. The room reads the SAB tick at the top of its
update, and the worker can publish the next step before the swarm encoder reads
the poses; such a packet carried tick T+1 poses labelled T, and with tick stamps
the drone popped one step forward for a frame or two (~every 14 frames in the
fleet-melee take 11). `SwarmBroadcaster` now passes `sabPoseTick(sabU32)`, the
SAB tick read under the seqlock right before each encode, as the header tick;
the room's `serverTick` still drives the full-snapshot and decimation cadence.
Lock: `src/server/rooms/SwarmBroadcaster.poseTick.test.ts`.

**Off-pilot buffer: size the delay to the outages when not flying (S5-9).**
While the player flies, the delay stays the S5-7 one (capped at
`ADAPTIVE_DELAY_CEILING_MS`, hold maximum `MAX_TOTAL_DISPLAY_DELAY_MS`): input
feel wins. Off the controls (Command, Build, spectate) nothing is steered, so a
1–2 s outage is better shown as delay than as a pause then a glide or re-sync.
`mirror/worldPasses.ts` sets the mode once per frame before
`stepSwarmDisplayDelay`: `selectControlMode(...) === 'fly'` is `pilot`,
everything else `offPilot`. The pieces, all in the existing homes:

- **Gap peak** (`stepGapPeak`, `noteSwarmStaleness` in `swarmDelayMode.ts`): a
  decaying max of the stream staleness (now − newest stamp), tracked in both
  modes. A larger staleness becomes the peak; one of at least
  `OFF_PILOT_GAP_REFRESH_FRACTION` (0.9) of it re-arms it; it holds
  `OFF_PILOT_GAP_HOLD_MS` (25 s) then decays (τ `OFF_PILOT_GAP_DECAY_TAU_MS`,
  5 s). Frames over `GAP_SAMPLE_MAX_FRAME_MS` (250 ms, a page stall) are skipped.
- **Target** (`swarmDelayTargetWallMs(input, speed, mode, gapPeak)`): pilot is
  the S5-7 clamp exactly; off pilot it is `max(pilot, min(3000 / speed, gap peak
  + OFF_PILOT_GAP_MARGIN_MS))` (`OFF_PILOT_DELAY_CEILING_MS` = 3000, margin 100).
- **Hold maximum** off pilot is `OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS` (4000)
  ÷ speed (`holdDisplayDelay(..., maxWallMs)`); undefined keeps the S5-5 bound.
- **Outage backlog keeps the tick clock** (`isOffPilotClockBacklog`): off pilot
  a packet more than `OFF_PILOT_BACKLOG_LATE_MS` (100 ms) and at most the hold
  maximum later than the tick clock is stamped on the existing offset (no
  re-seed, no drift-up). Without it a ≥ 1 s outage re-seeded the clock, the
  backlog was stamped at its arrival, and the ring had a hole the size of the
  outage: a freeze then a snap even with the delay covering it.
- **Ring thinning** (`ringThinningSpacingMs`, `getSwarmRingMinSpacingMs`): the
  decoder skips a ring write stamped less than `delay × 1.25 / (depth − 4)`
  after the newest slot, so the 28-slot ring covers a 3 s delay (~156 ms
  between samples). Pilot spacing is 0 (every packet written, unchanged).
  `swarmMirrorDelta.packPose` posts 0 slots for a skipped write. Missiles
  thin the same way (`MISSILE_POSE_RING_DEPTH` is now 16).
- **Catch-up on entering pilot** (`switchSwarmDelayMode`, `settleCatchUp`):
  the off-pilot bounds stay in force while the delay shrinks at
  `DISPLAY_DELAY_CATCHUP_TAU_MS` (60) and at most
  `DISPLAY_DELAY_CATCHUP_MAX_RATE` (6) × the frame: the read point
  fast-forwards at ≤ 7× real time (2.1 s → within 5 ms of the pilot target in
  ~0.5 s), never jumps or steps back. Growing always uses the normal slew.

Shells follow `getSwarmSteadyDisplayDelayMs` and need nothing new. Telemetry:
the lane `perf_summary` carries `delayMode` (`pilot` / `offPilot` / `catchUp`)
and `droneGapPeakMs`. Trade-offs: events still happen at present time
(missile detonation, drone deaths, explosion VFX), so off pilot they can lead
the drawn pose by up to the delay; a newly sighted drone pins to its first
sample until the read point reaches it. Locks:
`tests/scenarios/gapSmoothing.offPilotBuffer.test.ts` (1–2 s outages off
pilot: 0 freezes, 0 jumps; pilot unchanged; both switches),
`src/client/net/swarmDelayMode.test.ts`, `swarmMirrorDelta.test.ts`.

## The Step-4 regression (read this before touching ring/delay constants)

Raising `DISPLAY_DELAY_MS` to 100 with `POSE_RING_DEPTH` left at **4** was a
shipped regression (smoke cap `2026-05-18T18-56-32-1fc0oe`, user: "massive
lag … ship jumping, lasers lagging — not just drones"). The interpolator
reads at `now − 100 ms`; a 4-deep ring at the ~16.7 ms in-interest cadence
spans only ~64 ms, so the read point fell *before the oldest entry* →
`interpolateSwarmPose` pinned every drone to its stale oldest pose and
lurched one packet-of-motion every 16 ms. Because the (since retired)
kinematic follower drove the drone **collision** bodies to that pose
**inside the player's prediction world**, the lurch propagated to the
player ship and client beam geometry — one root cause, global symptom.
(Today a stale ring would still lurch the sprite and the beam end, but no
longer the collision bodies.)

**Load-bearing invariant:** `POSE_RING_DEPTH ≥ ceil(maxDisplayDelay /
minBinaryInterArrival) + headroom`, where the binding case is the
**in-interest binary cadence (~1000/60 ms)**, *not* the 50 ms JSON rate the
original sizing assumed. Now 28 (= ceil(400/16.7)=24 + 4): `maxDisplayDelay`
is the largest total delay, 400 ms after a dropout (owner decision D2; 150 ms
steady since S5-7, 280 before), not the steady ceiling; history 4 → 10 → 21 → 28 (gap-smoothing S3a,
S4-3). Cost ≈ 28 slots × ~10 fields × entities, about 0.6 MB at 214 entities.
Locked by the structural-invariant + interleaved-liveness tests in
[`tests/unit/swarmInterpolation.smoothness.test.ts`](../../tests/unit/swarmInterpolation.smoothness.test.ts)
and the steady-ceiling / 400 ms + one tick checks in
[`tests/unit/poseRingDepth.test.ts`](../../tests/unit/poseRingDepth.test.ts).

## Test locks

- **Deterministic per-frame canary (the real lock):**
  `tests/unit/swarmInterpolation.smoothness.test.ts` — interleaved tracking
  + the ring-sizing structural invariant + teleport guard, all with an
  injected clock (RED at depth 4, GREEN at depth 10).
- **Integration smoke (NOT the canary):** `tests/e2e/feel-test-lockstep.spec.ts`
  in the new 25-drone `feel-test-25` room. `data-obstacle-positions` is
  throttled ~13 Hz so the ~16 ms pin-sawtooth aliases away and
  `feel-test` drones idle-orbit — it asserts only regime + no gross
  cross-space teleport + server health, and says so in its header.
- **Signature lock:** `src/core/prediction/Reconciler.reconcile.test.ts` —
  a compile-time `@ts-expect-error` proves the retired drone replaySeed
  param cannot silently return; behaviour test proves player/remote replay
  intact.

## Accepted trade-offs

- **Render the past:** drones draw ~100 ms behind live (the deliberate
  cheat). Beam-vs-impact is bounded ≈ `droneSpeed × delay`; hits stay
  server-authoritative so it never changes whether you land a shot.
- **Player-vs-drone collision fidelity** during the player's reconcile
  replay: drones coast from their anchor (no client AI thrust), so a drone
  that turns hard inside the replay window can still cost a small
  correction. Far smaller than the retired follower's (100 ms + lead) lag.
- **Collision body leads the sprite** (since 2026-11-08): a fast drone's
  body is ~(100 ms + lead)·speed ahead of where it is drawn. The local ship
  can touch a drone slightly before the sprites meet; that is the server's
  answer too.
- **Residual "occasional ship/combat snap"** on device is the *separate,
  already-on-`main`* combat-lag baseline (Option A + bulk-gap + in-pack
  k-cap, see `reconciler-replay-scaling.md`) plus the explicitly-deferred
  respawn-cycle jank — **not** introduced by this pivot (it never touches
  player prediction). Do not re-chase it as a pivot regression.

## Future work

On-device feedback identified the next, *separate* priority: **weapons are
server-authoritative with no client-side hit prediction / favor-the-shooter**.
The shot *visual* is client-predicted (ghost bolt + `liveBeams`), but the
*hit outcome* (damage, target reaction, kill feel) waits a full `hit_ack`
RTT, so under latency weapon feedback is the first thing to visibly lag.
That is its own dedicated plan (client-side hit prediction +
confirm/rollback against the server `hit_ack`), not part of this pivot.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Drones are PURE snapshot-interpolated — no client brain (2026-05-18, drone-snapshot-interpolation pivot; supersedes the chapter-2 re-sim/lockstep design).** The client runs **no** drone AI. Drone pose comes off the binary swarm wire and is rendered via `interpolateSwarmPose` (display-delay buffer + teleport guard), exactly like asteroids/remote players. `ColyseusClient.updateMirror` writes that interpolated pose into the swarm mirror entry (for DRAWING only).

- **ONE PARADIGM for every remote moving entity — collision on the predicted timeline, rendering per type (2026-11-08, user decision "one system"; supersedes the "render == collision" kinematic follower).** Remote player ships, drones and scrap all get their predWorld collision body the same way: `preResetRemoteShips` anchors each to its latest server state on every snapshot (ships from `snap.states`, drones/scrap via `anchorRemoteSwarmBodies` from the pose ring at `snap.serverTick`), then the reconcile replay and every `tickPhysics` step move them forward with the local prediction. Nothing re-poses them per frame, so the local ship's own push on a drone or scrap survives until the server's answer arrives. Rendering stays per type: remote ships draw the predWorld body + a decaying lerp offset; drones/scrap draw the display-delayed interpolated pose (the 2026-05-18 jitter fix). So **a drone's body may LEAD its sprite** by ~(100 ms + lead)·speed, exactly as a remote ship's body can lead its sprite after a correction. Why: the retired follower posed the body at now − 100 ms while the local ship is predicted ahead of the server, so every melee contact resolved against a stale drone and corrected (`docs/LESSONS.md` 2026-11-08; showcase pack-battle 4–14 corrections/take). **Ray tests:** the local beam end and the optimistic hit prediction go through `DisplayPoseHitscan` (`combat/displayPoseHitscan.ts`): predWorld for everything else, but drones/scrap (`_movingSwarmKeys`) are skipped in predWorld and tested analytically at the DRAWN pose (the pose the turret aims at; the server aims its own mounts at the real drone). The server stays 100 % hit-authoritative. Scrap stays an unlocked dynamic mass-1 body (never lock it — the 2026-06-14 correction spike). **Capital wreck pieces (kind 4, S2b) are the same paradigm:** `isRemoteMovingSwarmKind` includes them; `WreckClientLeaf` builds an unlocked body from the geometry `WreckGeometryStore` rebuilt off the wreck descriptors`snap.wrecks[]` (no vertex on the wire; a piece gets no body or sprite until its descriptor arrives). Slice 3: the store takes the welcome's full `wrecks` (`apply`) and each snapshot's `wreckSync` → `wreckRemoves` → `wreckAdds` (`applySnapshot`, in that order, idempotent, alloc-free guards `isWreckDescriptor` / `isWreckId` instead of a zod parse). All three are absent-means-no-change: `SnapshotCoalescer` folds a dropped snapshot's into the newer one (`carryWreckDeltas`), and the DataChannel byte coalescer decodes a superseded frame that carries `wreckAdds` / `wreckRemoves` (`carriesWreckDeltas` byte scan) instead of discarding it, and `DisplayPoseHitscan` tests them at the drawn pose with the server's `wreckRayHit`. The renderer keeps its own store fed from `RenderMirror.wrecks` (the worker has its own heap) and draws each piece as a `WreckPieceSprite` (S3, `render/pixi/wreckArt.ts`): the parent kind's EXISTING baked art (never a new bake or texture) on one batched Mesh per hull tile, UVs = the piece's hull-local positions, or, for GPU-lit art (the player's default `shiplight`), one `LitShipMesh` per tile in the HULL's frame registered with `litPass` (drawing the unlit data maps through the default shader gave flat grey slabs: money-shot review; the GPU-lit case in `capital-wreck-render.spec.ts` locks it), plus one cut-edge glow mesh timed from the descriptor's `deathTick` (late joiners: cool), lit by a crack front from the kill point over `WRECK_CRACK_MS` with small seeded ripple blasts along the cuts (tier-capped, game clock; capital-destruction.md "Cracks spread"); the plain `buildWreckPieceGfx` polygon until the art is ready. A fresh wreck's break-up goes through `effects.spawnBurst('wreck-break')` (tier-capped). **The dying hull stays drawn until its pieces are** (`render/pixi/dyingHullHold.ts`, 2026-11-13): a capital dying in a `capitalWrecks` room is not destroyed by the sprite sweeps but held at its last pose until EVERY piece of its wreck (the wreck of the first same-kind piece drawn inside its hull; count from the rebuilt geometry) is drawn, the pieces that arrived earlier hidden meanwhile so no frame shows a partial wreck (same-frame hand-over), or 1.5 game-seconds pass; never sweep a dying capital's sprite directly (lock `dyingHullHold.test.ts`). Locks: `tests/unit/wreckPredWorld.test.ts`, `swarmSpriteUpdater.wreck.test.ts`, `swarmSpriteUpdater.wreckArt.test.ts`, `wreckArt.test.ts`, `tests/integration/wire/wreckGeometryParity.test.ts`. Do NOT add a drone-specific collision/dead-reckoning path or re-pose swarm bodies per frame. Locks: `tests/scenarios/meleeDroneContactPrediction.test.ts` (production anchor within the pose gate for drones and scrap; the retired follower as contrast), `snapshotRemoteSync.remoteEntityAnchor.test.ts` (anchor source + remote-ship regression lock), `displayPoseHitscan.test.ts`, `remoteEntityAnchor.heapDelta.test.ts`.

- **Drone drawn pose: the one-pose-per-frame rule.** **ONE-POSE-PER-FRAME RULE (load-bearing, enforced 2026-05-19 — was previously only *claimed* here):** `interpolateSwarmPose` is called for a given drone **exactly once per frame — in `updateMirror`, at that frame's single `now`**. Every other consumer (the `PixiRenderer` sprite for `kind===1`, the beam ray's drawn-pose test, the turret/laser aim `buildLocalAimTargets`, health bars, labels) **MUST read the resolved `entry.x/y/angle` and MUST NOT call `interpolateSwarmPose` again.** The greppable, unit-lockable seam for this is [`resolveEntityDisplayPose`](../../src/client/net/swarmDisplayPose.ts) — use it; never re-interpolate a drone in a consumer. Re-interpolating in a consumer resolves the pose at a *different* `now` than the frame's single resolution (render-now / tickPhysics-now ≠ updateMirror-now, raf-jitter-amplified, a whole frame under the 30 Hz worker sprite gate), so the sprite, aim and beam disagree every frame: that **was** the on-device "drones jitter like two things fighting / laser jitters vs where it's drawn" bug (2026-05-19, capture `…-jfagww`; `0e24448`'s aim-via-`interpolateSwarmPose` was directionally right but added a 3rd divergent-`now` site — subsumed). The accepted residual is a smooth ≤1-frame aim lead-lag (`buildLocalAimTargets` runs in `tickPhysics`, before `updateMirror`, so it reads the prior frame's pose), never per-frame jitter. **Exception:** asteroids (`kind===0`) keep render-now `interpolateSwarmPose` off the poseRing — they are locked/static server-side, were never the jitter complaint, and `syncSwarmIntoPredWorld` still poses their bodies from the raw decoded `entry.x/y` (the decoder is deliberately UNCHANGED — it still writes the raw pose + feeds the poseRing; the per-frame resolve overwrites the drone `entry.x/y` before any consumer reads it). `SnapshotMessage.drones[]` is a slim `{ id, mountAngles?, shieldDown? }` turret/shield slice only — x/y/vx/vy/angle/angvel flow ONLY on the binary channel. `_aiController` survives as a **hostility ledger only** (`markHostile`/`isEntityHostileToPlayer`, fed by `damage`/`bot_aggro`); its brain is never ticked. **RETIRED:** `tickClientAi`, `AiController.tickOnly`, `partitionDronesByRelevance`/`droneRelevance.ts`/`DRONE_RESIM_BUDGET`, `_droneSnapshotAnchored`, `_droneRenderOffsets`/`_droneLastSnapDist`, `swarm_snap_diagnostics`/`stats.swarmSnap*`, the `Reconciler.reconcile` drone replay-seed (6th param), `anchoredDroneReseedSmoothing`. The `perReplayTick` hook now does **only** `applyRemoteInputs()` (remote-*player* forward-prediction). The "one correction path / dual-path lockstep" concern **dissolves for drones** — there is no client drone sim to fight. **Load-bearing invariant:** `POSE_RING_DEPTH` must cover `DISPLAY_DELAY_MS` at the *in-interest binary cadence* (~1000/60 ms), NOT the 50 ms JSON rate — under-sizing it pins drones to a stale pose (drawn lurch / lasers lag; the Step-4 regression, cap `2026-05-18T18-56-32-1fc0oe`; at the time the since-retired kinematic follower also carried the lurch into predWorld). Full story: [docs/architecture/drone-snapshot-interpolation.md](../../docs/architecture/drone-snapshot-interpolation.md). Regression locks: the **deterministic** per-frame canary is [tests/unit/swarmInterpolation.smoothness.test.ts](../../tests/unit/swarmInterpolation.smoothness.test.ts) (interleaved tracking + ring-sizing structural invariant + teleport guard); [tests/e2e/feel-test-lockstep.spec.ts](../../tests/e2e/feel-test-lockstep.spec.ts) is an honest 25-drone integration *smoke* (NOT the canary — the position attribute is throttled ~13 Hz); [src/core/prediction/Reconciler.reconcile.test.ts](../../src/core/prediction/Reconciler.reconcile.test.ts) locks the no-drone-seed signature. The one-pose-per-frame rule is locked by [tests/unit/swarmPoseConsistency.test.ts](../../tests/unit/swarmPoseConsistency.test.ts) (deterministic per-frame core: aim reads the written pose; the seam == the written pose) and [tests/scenarios/droneOnePoseAcrossFrames.test.ts](../../tests/scenarios/droneOnePoseAcrossFrames.test.ts) (across-frames App-loop-ordering boundary lock: sprite === the beam's drawn-pose test every frame, aim===prev-frame, monotonic-no-fight).
