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

## The feel core — display delay sized to the *binary* cadence

`DISPLAY_DELAY_MS` 0 → **100 ms**. The old "0 ms aligns render with the
predWorld collision body" rationale is obsolete: the delay only affects
drawing (the collision body runs on the predicted timeline, above). 100 ms backward-buffers
the in-interest combat cadence (binary ships ~per server tick, ≈16.7 ms) so
two bracketing samples essentially always exist → a true lerp of buffered
authoritative truth, immune to wire jitter ≤ 100 ms. The adaptive delay is
now sized from the **binary packet inter-arrival EWMA** (the real
drone-pose channel), NOT the 20 Hz JSON snapshot interval;
`ADAPTIVE_DELAY_CEILING_MS` 200 → 280 so a decimated out-of-interest drone
(~100–170 ms) still brackets two samples; extrapolation now glides angle by
`angvel·dt` instead of freezing it. `DISPLAY_DELAY_MS` is the on-device
tuning knob (start 80–110 ms).

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
original sizing assumed. Now 10 (= ceil(100/16.7)=6 + 4). Locked by the
structural-invariant + interleaved-liveness tests in
[`tests/unit/swarmInterpolation.smoothness.test.ts`](../../tests/unit/swarmInterpolation.smoothness.test.ts).

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
