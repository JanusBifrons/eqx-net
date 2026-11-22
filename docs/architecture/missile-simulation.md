# Missile simulation — internals

How heat-seeking missiles live, breathe, and die inside EQX Peri.

The missile subsystem is built around two priorities the user
specifically flagged:
1. **Network bytes**.
2. **GC pressure**.

Everything below — the pre-allocated pool, the JSON-vs-binary wire
choice, the AOI filter, the impulse queue — exists because of those.

## High-level data flow

```
                       ┌─────────────────────────────────────┐
client (player fires)  │  PlayerFireResolver — mode='missile'│
   │                   │     ↓                               │
   │                   │  SectorRoom.spawnServerMissile      │
   │                   │     ↓                               │
   │                   │  MissileSimulation.spawn()          │
   │                   │     ├── pickTarget (lock-at-launch) │
   │                   │     ├── pool free-list pop          │
   │                   │     ├── emit MISSILE_FIRED (local)  │
   │                   │     └── broadcast 'missile_fired'   │──> all clients
   │                   │                                     │
   │                   │  per tick (in update):              │
   │                   │  MissileSimulation.advance()        │
   │                   │     ├── lock verify (resolve id)    │
   │                   │     ├── proximity fuse check        │
   │                   │     ├── guidance yaw (turnRate clamp)│
   │                   │     ├── record angvel (Δangle / DT)  │
   │                   │     ├── integrate position          │
   │                   │     ├── sweep player + swarm        │
   │                   │     ├── lifetime decrement          │
   │                   │     │    └─ on expiry: detonate      │
   │                   │     │       (cause='lifetime',       │
   │                   │     │        no splash, broadcasts)  │
   │                   │     └── (on detonate)               │
   │                   │         ├── splash damage           │
   │                   │         ├── enqueue impulse         │
   │                   │         ├── emit MISSILE_DETONATED  │
   │                   │         └── broadcast 'missile_     │──> AOI-filtered clients
   │                   │              detonated'              │
   │                   │                                     │
   │                   │  SectorRoom.update() then drains    │
   │                   │  the impulse queue:                 │
   │                   │     missileSim.drainImpulses()      │
   │                   │       postToWorker MISSILE_IMPULSE  │──> physics worker
   │                   │                                     │
   │                   │  SnapshotBroadcaster encodes        │
   │                   │  missileSim.live() into             │
   │                   │  SnapshotMessage.missiles[] (AOI)   │──> client
   └───────────────────┘                                     │
                                                             │
   ↓                                                         │
   ColyseusClient.handleSnapshot                              │
       applyMissileSnapshot(snap.missiles, mirror, ...)      │
   ColyseusClient.onMessage('missile_detonated', ...)        │
       removeMissile + push pendingMissileExplosions          │
                                                             │
   PixiRenderer.update()                                     │
       updateMissileSprites:                                 │
         - sprite per missileId, single-pose-per-frame       │
         - drain pendingMissileExplosions → spawn VFX        │
         - fade + reap explosions over 400 ms                │
```

## Why JSON snapshot, not binary swarm wire

The original plan called for promoting missile pose onto the binary
swarm wire (bumping `SWARM_WIRE_VERSION` 3 → 4 + adding a
`SWARM_KIND_MISSILE = 2`). On reading the wire-layer code, the
infrastructure cost turned out to be substantial:

- `SwarmEntityRegistry.SwarmKind` is `0 | 1` (asteroid/drone) and the
  registry is built around SAB-slot-backed pose. Missiles don't have
  Rapier bodies — they're pure Euler integration on the server main
  thread, like projectiles — so they can't share the SAB-slot path
  without major plumbing.
- `BinarySwarmBroadcast.encode` reads pose from
  `sabF32[base + SLOT_X_OFF]` — adding a non-SAB pose source means
  branching the encoder and managing a parallel registry.
- `MAX_ENTITIES = 1024` is the u16 entityId space; missiles would
  need to share or allocate from this pool, with all the lifetime
  bookkeeping that implies.
- The decoder, interest grid, and pose ring all assume one record
  shape per wire packet.

For the expected missile counts (~5-30 in flight at any given
moment), the bytes-on-wire delta between binary (33-byte record) and
JSON (~50-byte record) is small in absolute terms — under 1 KB/s in
the steady state. The JSON path piggybacks on the existing
`SnapshotMessage.projectiles[]` pattern, which is already AOI-filtered
per recipient and already has a decoder. Implementation cost ≈ 30
minutes; binary integration cost ≈ a full day.

**The future-promotion knob**: when sustained in-flight missile counts
cross ~50 (frigate-heavy combat at scale), the right move is a
`MissileWireFormat.ts` parallel to `swarmWireFormat.ts` and a
`MissileBroadcast.ts` parallel to `BinarySwarmBroadcast.ts` — a
*separate* binary channel, NOT a swarm-wire kind. Reasons: the registry,
SAB, and pose-ring infrastructure stay missile-free, and the swarm wire
keeps its single-purpose shape.

## Fire-rate enforcement

Per-weapon cooldown is read from `weaponDef.cooldownTicks` in BOTH
`PlayerFireResolver` and `AiFireResolver`. Heat-seeker = 180 ticks
(3 s); hitscan + laser stay at 10 ticks (167 ms) as before.

Pre-missile, both resolvers gated against a single
`WEAPON_COOLDOWN_TICKS = 10` constant (the hitscan cooldown,
re-exported from `Weapons.ts`). That worked while every weapon shared
the same cadence, but missiles broke the assumption: a misbehaving or
replay-attacking client could have spammed `fire` messages at the
hitscan rate and launched ~6 missiles/sec per mount — saturating the
256-record pool and the AOI band. Moving the gate to
`weaponDef.cooldownTicks` closes that hole; the server enforces
exactly the cadence the catalogue advertises.

The constant `WEAPON_COOLDOWN_TICKS` is still exported from
`Weapons.ts` for back-compat with anything that imported it for
unrelated purposes; the two fire resolvers are the only ones that
used it as a fire-rate ceiling, and they no longer do.

## The pool

`MissileSimulation.pool` is a fixed `MissileRecord[]` of capacity 256,
allocated once at room construction. `freeIndices: number[]` is a LIFO
stack of free indices; `liveIndices: number[]` is the active set.

- **Spawn**: `freeIndices.pop()` → populate fields → push to
  `liveIndices` → return missile id.
- **Release**: swap-with-last in `liveIndices`, mark `alive=false`,
  push back onto `freeIndices`.
- **Overflow** (`freeIndices.pop()` returned `undefined`): `spawn()`
  returns `null`. The fire path treats this as a soft reject — no wire
  message, no SFX. A future telemetry sampler can read
  `highWaterCount()` and emit a Pino warn when saturation gets close.

Zero per-tick allocation in steady state. The `live()` generator and
`snapshotSlice()` are the only places where small arrays are built;
both are bounded by the active missile count.

## Lock-at-launch + id-reuse safety

`spawn()` calls `pickTarget` from the pure
`WeaponMountController.pickTarget` module over (players + swarm
entities), filtered by an injected `isHostile` predicate. The chosen
target's **string id** (`playerId` for players, `swarm-${entityId}` for
drones) is stored on the missile.

The hostile-review surfaced an id-reuse concern: the dense u16
`entityId` space (`MAX_ENTITIES = 1024`) wraps, so a drone killed and
respawned could share a slot. But `SwarmEntityRegistry.register`
throws on duplicate **string ids**, and the missile tracks the string
id — so id reuse at the dense slot level has no effect on missiles.
The lock verifies each tick that `swarmRegistry.get(lockedTargetId)`
still resolves; for players, that `getActiveShip(lockedTargetId)`
returns an active+alive ship.

If the lock resolves to nothing, the missile drops the lock and flies
straight. It does not re-acquire — the user accepted that lost-lock
missiles are dumb. (A future enhancement could re-pick on the next
tick, but the simpler "commit" rule is closer to the player's mental
model of a heat-seeker that "remembers" its target.)

## Impulse dispatch into the physics worker

The server main thread has no live Rapier world (physics lives in the
worker — see `src/server/CLAUDE.md` "Threading"). So
`MissileSimulation` cannot call `body.applyImpulse(...)` directly.

Instead: `detonate()` enqueues `{ targetId, fx, fy }` onto
`pendingImpulses[]`. The SectorRoom drains the queue each tick (right
after `missileSim.advance()`) and posts each entry as a
`MISSILE_IMPULSE` `WorkerCommand`. The worker's command handler routes
to `physics.applyImpulse(entityId, fx, fy, 0)`, which silently no-ops
on unknown ids — so a drone that died between detonate and apply is a
clean miss, not a crash.

The "0 torque" is deliberate: missile impulse is meant to read as a
shove, not a spin. The splash query computes the unit vector from
detonation to target (using `splashFalloffMin` as the denominator
floor so point-blank doesn't divide by zero), scales by
`splashImpulse * falloff`, and that's the linear impulse.

## Splash damage math

```
dist    = max(splashFalloffMin, hypot(targetPos - detonationPos))
falloff = (splashFalloffMin / dist)²
damage  = baseDamage * falloff      (+ directImpulseBonus on primary)
impulse = (unit dir) * splashImpulse * falloff
```

At `dist == splashFalloffMin`, `falloff == 1.0` — damage and impulse
land at the catalogue maximum. At `dist == splashRadius == 60`,
`falloff == (10/60)² ≈ 0.028` — about 3 % of the peak damage and
impulse. Outside `splashRadius` the target is skipped entirely.

The `splashFalloffMin` clamp is what keeps the formula numerically
stable AND keeps direct hits from delivering wildly variable damage
based on sub-unit position differences.

## Lingering hulls are collidable (WS-2 / R2.22 symptom 3, 2026-06-12)

A **lingering hull** (a disconnected / fresh-spawn-displaced ship,
`isActive=false`) is still a solid world object — a fired missile must
collide with it, not pass through. Both the per-tick `sweepCollision`
and the `detonate` splash loop iterate `lingeringSlots` (the
authoritative set of lingering hulls) and read each one's live pose from
`lingeringPoseCache` (written per-tick by `SabPoseMirror`), mirroring
`PlayerFireResolver`'s lingering-hit path. On a hit the missile returns
the **`shipInstanceId`** (not a `playerId`), which `EntityResolver`
routes to the lingering leaf so layered shield/hull damage lands. The
loops are allocation-free (`for…of` over the slot map, scalar scratch).

Scope: this is **collision only** — `lockOnTarget` still does NOT home
onto lingering hulls (the hostility predicate is keyed by `playerId`, not
`shipInstanceId`, so homing would entangle the targeting system; an
in-flight missile colliding with an abandoned hull is the reported bug
and the right-sized fix).

## Asteroids are solid — missiles detonate, never pass through (WS-2b / R2.22 symptom 2)

`sweepCollision` includes asteroids (swarm `kind === 0`), not just drones. Per
the [asteroid-interaction-model ADR](asteroid-interaction-model.md), asteroids
are SOLID, indestructible rock: a missile sweeping into one **detonates +
despawns on contact** (impact VFX) and deals **0 HP** — `applyDamage` no-ops on
the immune asteroid id (no `swarmHealth`), which is correct; the bug being fixed
was the missile *passing through*, not the zero damage. Asteroids remain **not
lockable** — `lockOnTarget` keeps its `kind === 0` skip, so a missile never
*homes* on rock; it only can't fly through it. Lock:
`missileLifecycle.test.ts` (a missile fired at an asteroid emits a
`missile_detonated` broadcast instead of expiring).

## Lifetime expiry detonates (no damage) — WS-C #14 (2026-06-20)

A missile that never lands a direct hit still has to LEAVE the world cleanly. The
2026-06-06 "impact-only" pass made lifetime expiry call `releaseAtPos()` SILENTLY
(no `missile_detonated` broadcast) on the theory that the client would alpha-fade
the sprite over its last 15 % of life and reap it when it left the `missiles[]`
slice. On-device that read as **"the missile stops, then fades"**: the client's
extrapolation dead-reckons past the newest sample, **caps at
`MISSILE_EXTRAPOLATION_CAP_MS` then FREEZES**, and the stale `lifePct` fade plays
over the frozen sprite — a visible stutter at end of life.

Fix: on lifetime expiry `advance()` now calls
`detonate(m, m.x, m.y, null, null, 'lifetime')` before `releaseAtPos`. This fires
the `missile_detonated` broadcast (+ local `MISSILE_DETONATED` bus event), so the
client's `removeMissile()` clears the sprite the same frame and the explosion VFX
plays — a clean finish, not a frozen ghost.

The **impact-only DAMAGE design is preserved**: `detonate()` SKIPS all three
splash loops when `cause === 'lifetime'`, so a fizzle deals zero damage (a missed
missile must not splash in-place — that was the deliberate 2026-06-06 change). The
broadcast is for the client clear + VFX only. `'lifetime'` was already a valid
`DetonateCause` (it had only ever been used as a diag tag); it now also drives the
real detonation path with the splash suppressed.

Locks: `missileLifecycle.test.ts` "WS-C #14" (a dumb missile flown to lifetime
expiry broadcasts `missile_detonated` AND deals no damage — FAILS on the silent
`releaseAtPos`) + `MissileSimulation.pool.test.ts` (`detonatedCount === 2`,
`applyDamageCount === 0` after two missiles expire). No wire change → NO netgate.

## Proximity fuse

The proximity-fuse check runs **before** guidance each tick. If the
locked target is within `proximityFuseRadius` (default 36 units = 60 %
of the splash radius), the missile detonates *in place*, with the
locked id as the primary target.

This solves the "missile flies past dodging target" complaint. Without
proximity-fusing, a 6.67 u/tick missile (heat-seeker at 60 Hz) that
misses by 20 units zooms past the target in 3 ticks, well outside its
splash radius before the next-tick sweep can intersect anything. With
proximity-fusing, the target's evasive arc still costs them — they
feel the explosion even on a successful dodge, just at a reduced
falloff.

## One-pose-per-frame on the client

`MissileMirror.resolveMissileDisplayPose` is the **single ownership
site** for client-side missile pose, mirroring the
`resolveDroneDisplayPose` rule documented in `src/client/CLAUDE.md`.

If a future consumer (camera-shake-source resolver, missile trail
emitter, audio source) needs the missile's display position, it MUST
read the resolved value cached for that frame. Re-calling
`resolveMissileDisplayPose` at a different `now` would produce a
different pose, and the sprite, trail, and other consumer would
disagree per frame — the same per-frame jitter class the drone
interpolation pivot eliminated.

Today the only consumer is `missileSpriteUpdater.ts`, which resolves
once per missile per frame and writes `sprite.x / sprite.y /
sprite.rotation` from the cached pose. Future consumers add their own
read-once-per-frame cache from the same seam.

## Sample stamps — the drone tick timeline (netcode gap smoothing S5-2)

Each ring sample's `arrivalMs` is its **playback stamp**, not its arrival
time. `applyMissileSnapshot` stamps every missile in a slice with
`swarmTickToStampMs(snap.serverTick, now)` (`swarmInterpolation.ts`): the
snapshot's server tick placed on the same tick clock the drones play on,
read-only, so missiles never steer that clock. Arrival stamps carried
network jitter and frame stalls into playback: a backlog drained in one
frame got near-equal stamps and the missile played at an uneven speed; tick
stamps keep the server's 50 ms spacing. The wire carries no per-missile
tick, so the snapshot tick is the basis; a missile stepped ahead of it
(`MissileSimulation.advance` steps at least once per room update) shows as a
small fixed offset. Before the tick clock is seeded (no drone packet yet,
e.g. a sector with no drones) the call returns NaN and the sample keeps
its arrival stamp. If a newer tick would be stamped at or before a sample
already in the ring (the clock seeds mid-flight, or re-seeds), the whole
ring is re-stamped from each sample's own `serverTick`, in place, so ring
order never runs backwards. `latestArrivalMs` stays the real arrival time
(slice-driven despawn). The teleport guard scales the wall-ms stamp span by
`mirror.timeScale` before `isImplausibleJump`, whose bound is a game-time
speed. Locks: `MissileMirror.test.ts` (backlog spacing, NaN fallback,
re-stamp, teleport span at 2× and 0.7×) and
`tests/scenarios/gapSmoothing.missiles.test.ts`.

## Display delay — the shared drone delay (netcode gap smoothing S5-4)

Missiles read at the drone display delay, so a missile and the drone it
chases are drawn at the same lateness. With a fixed 100 game-ms missile delay
against the adaptive drone delay, missile minus drone mean lateness was
−52 ms at gap-200, −90 ms at gap-600 and −146 ms on jitter-4g; now it is
within 2 ms on every missile fixture except the two 600 ms stalls of both
streams (+3.1 ms, see below). Missiles are resolved in the renderer, which
on desktop is a worker without the drone delay's module state, so the value
rides the mirror: `updateSwarmMirror` (`mirror/worldPasses.ts`) calls
`publishSwarmDisplayDelay(mirror)` once per frame right after
`stepSwarmDisplayDelay`, writing `getSwarmDisplayDelayMs()` into
`mirror.swarmDisplayDelayMs`. The value is already WALL ms (the drone floor
and ceiling are divided by the speed), so `resolveMissileDisplayPose` uses it
as is, never ÷ `timeScale` again. It includes the S4-5 stall hold and the
slew, so missiles follow both. Before the first tick-stamped drone packet
after a reset (`getSwarmStreamNewestStampMs()` is NaN: a sector with no
drones) it publishes NaN and missiles fall back to
`MISSILE_DISPLAY_DELAY_MS / timeScale`, the same moment their samples fall
back to arrival stamps. Through a 600 ms stall of both streams the missile
still freezes a little before the drone: its newest sample is up to two
ticks older (the JSON stream carries every third tick), so it reaches its
250 ms extrapolation cap first while the drone's read point is held; the
missile hold (S5-5, below) removes the snap but not that offset. Locks:
`MissileMirror.test.ts` (follows a changed delay, unseeded fallback, wall ms
at 2× and 0.7×) and the "same lateness" test in `gapSmoothing.missiles.test.ts`.

## Missile stream hold and game-ms dead-reckon (netcode gap smoothing S5-5)

Missiles ride the JSON snapshot stream and drones the binary swarm stream;
the two can stall separately. So the missile stream has its OWN display-delay
record run through the SAME slew and hold as drones: the shared functions
`slewDisplayDelay` and `holdDisplayDelay` in `src/client/net/displayDelayHold.ts`
(owner decision D10 = A; no second copy of the algorithm, see
`drone-snapshot-interpolation.md`). `applyMissileSnapshot` notes every
snapshot's tick stamp as the JSON stream's newest stamp (with missiles or
not: any snapshot shows the stream is alive; the newer tick wins).
`stepMissileDisplayDelay(mirror, frameDtMs, nowMs)` runs on the main thread
once per frame right after `stepSwarmDisplayDelay` (`mirror/worldPasses.ts`):
its target is the drone delay's target (same lateness on a live link: the
record starts at the drone delay and follows the same steps), and its hold
parks the missile read point at "JSON newest + `MISSILE_EXTRAPOLATION_CAP_MS`
÷ speed", re-syncing (counted once per stall) past
`MAX_TOTAL_DISPLAY_DELAY_MS` ÷ speed, as drones do. The result rides the
mirror as `mirror.swarmDisplayDelayMs` (the renderer may be a worker); NaN
before the drone tick clock seeds, as before. `resetMissileDisplayDelay`
(called by `resetPredictionState`) clears it; `getMissileHoldFrameCount` and
`getMissileResyncCount` are the telemetry.

The dead-reckon now runs in game ms: ring stamps are wall ms and velocities
are per game second, so every dt in `resolveMissileDisplayPose` (the
single-sample reconstruction, the extrapolation and the curve interpolation)
is wall ms × `timeScale`, and the 250 game-ms cap is ÷ `timeScale` in wall
ms (as drones, S4-1b). At 2× a missile used to dead-reckon half as far as it
flew, at 0.7× 1.4× as far.

Effect on the 1× fixtures (missile; before → after): gap-400 1 snap of 14.2 u
→ 0, mean lateness 210.57 → 221.66 ms; gap-600 and burst-600-both-streams
1 snap of 15.7 u → 0, 248.44 → 258.66 ms; gap-json-only 1 snap of 41.95 u → 0,
141.81 → 157.32 ms. Freeze frames (5, 17, 17, 5), max lateness and lan-clean,
gap-200, frame-stall-250 and jitter-4g are unchanged; drone numbers are
unchanged. Known gap: through a stall of both streams the missile is drawn
later than the drone (+12.07 ms mean at gap-400, +13.33 ms at gap-600), because
its newest sample is up to two ticks older, so its hold starts that much
earlier and both records slew back at the same bounded rate. Equal lateness
there would need the missile read point to follow the drone hold, which would
break independence (a JSON-only stall must hold missiles and not drones: at
gap-json-only the missile is drawn +17.32 ms later than the drone by design).
Locks: `MissileMirror.test.ts` (independence both ways, re-sync counted once,
dead-reckon and cap at 2× and 0.7×) and `gapSmoothing.missiles.test.ts`.

The read time is main-thread time too (S5-W): `updateMissileSprites` resolves
poses at `mirror.frameTimeMs` (`missilePoseNowMs`), not the renderer's
`performance.now()`. A worker's clock counts from its own `timeOrigin`, later
than the page's, so the worker's `now − delay` sat that far behind every
main-thread stamp and desktop missiles were drawn up to a display delay behind
their oldest sample. Trails and explosion fades keep the renderer clock. Lock:
`missileSpriteUpdater.test.ts` (a 5000 ms worker offset draws the
main-thread-resolved pose).

## Shells read the drone delay before the hold (netcode gap smoothing S5-6a)

Naval shells (`shell-events.md`) are drawn in closed form at a display tick:
clock anchor minus a delay (`updateProjectilesMirror`, `mirror/worldPasses.ts`).
They used a fixed 100 game ms, so on jitter-4g a shell was drawn ~106 ms
earlier than the drone it flies past. They now read the drone delay BEFORE
the S4-5 stall hold: `getSwarmSteadyDisplayDelayMs()` in `swarmInterpolation.ts`,
the `steadyMs` field of the shared drone record (`displayDelayHold.ts`),
which `slewDisplayDelay` moves toward the same target on the same frame step
and `holdDisplayDelay` never touches (the missile record carries it unused), converted to game ms by `shellDisplayDelayGameMs`
(`shellDisplayDelay.ts`, × `gameClock.scale`; NaN / 0 / non-finite falls
back to 100 game ms). In steady play it equals the held drone delay, so
shells line up with drones; through a drone stream stall the held delay grows
but the steady one does not, so shells keep flying. Shells run on the main
thread after `updateSwarmMirror`, so no mirror field is needed. Feeding the
HELD delay (the parked S5-6 attempt) froze shells 3 / 15 / 15 / 3 frames on
gap-400 / gap-600 / burst-600-both-streams / gap-swarm-only; a shell's path
is known, so it never needs the hold. Effect (shell, fixed → steady): 0
freezes and 0 snaps on every profile except jitter-4g (18 → 13 snaps);
shell − drone mean lateness lan-clean +14.67 → +14.67 ms, gap-200 −42.31 →
+9.60, gap-400 / gap-swarm-only −59.59 → −18.48, gap-600 / burst-600 −95.33 →
−63.99, jitter-4g −105.89 → +37.56. The ~+15 ms on a clean link is the clock
anchor vs the drone tick clock (known, out of scope); the negative numbers in
the stalls are the drones' hold, not the shell. Locks:
`shellDisplayDelay.test.ts` (steady ignores the hold at 1×, 2×, 0.7×) and
`tests/scenarios/gapSmoothing.shells.test.ts` (no added freezes or snaps,
shell − drone on lan-clean and jitter-4g no worse than recorded).

## Curve-aware interpolation — `angvel` on the wire (WS-C #5, 2026-06-20)

Missiles ride the 20 Hz JSON snapshot (see "Why JSON snapshot" above), and a
prior fix gave `MissileMirror` a per-missile pose ring + display-delay
interpolation (Issue 11). But the ring carried only `x/y/vx/vy/angle` — **no
angular velocity** — so the client dead-reckoned a STRAIGHT line off the last
snapshot's `vx/vy` between arrivals. Heat-seekers STEER (homing), so the server's
true path between two snapshots is an ARC: the straight client guess bowed away
from it and **snapped onto the new pose on every ~50 ms arrival** — the
long-standing "missiles are jerky / still look like 20 Hz" report. This was the
real, never-fixed root cause (the ring fix smoothed *jitter*, not the *curve*).

The fix adds a **signed `angvel` float** (rad/s) to `SnapshotMessage.missiles[]`:

- **Server** (`MissileSimulation.advance`): after the guidance yaw step, records
  `m.angvel = wrapPi(m.angle − angleBefore) / DT` — the actual applied turn this
  tick (wrapped, so it matches the integration; 0 on a dumb-flying or
  just-spawned missile). It rides `MissileSnapshotEntry` → `MissileBroadcasterView`
  → `SnapshotBroadcaster.writeMissileSlot` (pooled scratch, invariant #14).
- **Client** (`MissileMirror`): the ring stores `angvel`; `resolveMissileDisplayPose`
  integrates `angle += angvel·dt` and **recomputes position from the curved
  heading** via the pure `curveDeadReckon` helper — the exact constant-turn
  circular-arc closed form `pos += (s/ω)·(dir(angle+ω·dt) − dir(angle))`, where
  `s = |v|` and `dir(θ) = (−sinθ, cosθ)` (Pixi-up, matching the server). This
  applies to BOTH branches:
  - **Interpolation** dead-reckons forward along the arc from the OLDER bracket
    sample, reconstructing the inter-snapshot path the server integrated.
  - **Extrapolation** past the newest sample keeps TURNING (was: held a frozen
    heading and coasted straight — which flew off the arc and snapped).
- **Back-compat:** `angvel` is optional, back-fills to `0`; a near-zero angvel
  takes the linear fast path, byte-identical to the pre-WS-C behaviour (and to
  the legacy locked interpolation tests). So a pre-WS-C server, a dumb-flying
  missile, and a straight projectile are all unchanged.

**Why missiles and not laser bolts / projectiles:** projectiles fly STRAIGHT —
they have no steering, so `angvel` is always 0 and linear dead-reckoning is
already exact. Adding angvel to the projectile slice would only add bytes for a
field that's always zero. The decision is documented here so it isn't re-litigated.

**Wire impact:** +1 optional float on the per-recipient `missiles[]` slice (only
non-zero when a missile is actively turning). Touches the snapshot/broadcast
path, so the **netcode-health gate (invariant #8) applies** on CI.

Lock: `MissileMirror.test.ts` "HOMING CURVE" (the angvel-interpolated path tracks
a simulated server arc within ~2 u — FAILS on the old linear lerp by ~4 u) and
"EXTRAPOLATION past newest applies angvel" (angle keeps turning past the newest
sample). The pure `curveDeadReckon` is exercised through both branches.

## Bus events

Per the root CLAUDE.md event-bus rules, missile lifecycle events are
**discrete** (spawn / detonate — instantaneous low-frequency
transitions), and the cross-process channel is Colyseus broadcast
(not the bus, which is per-process).

| Event | Local bus (`src/core/events/Bus.ts`) | Wire (Colyseus) |
|---|---|---|
| Missile launched | `MISSILE_FIRED` | `missile_fired` |
| Missile detonated | `MISSILE_DETONATED` | `missile_detonated` |

`MISSILE_FIRED` is broadcast to **all clients** (low cadence — at
heat-seeker's 180-tick cooldown that's ~0.33 events/sec per mount).
`missile_detonated` is **AOI-filtered server-side** so a detonation
on the far side of the sector doesn't waste bytes on a client who
can't see it — same shape as the existing `laser_fired` filter for
remote shooters.

The client's `ColyseusClient.onMessage` handlers `safeParse` each
inbound message with the zod schema from
`src/shared-types/messages/missileMessages.ts` and drop malformed
payloads silently (invariant #3).

## SOLID notes

- **S** — `MissileSimulation` owns guidance + lifecycle only. Damage
  applies through `applyDamage`; impulse applies through the worker
  queue. Splash query reads pose from existing caches (SAB + ship
  pose cache).
- **O** — Future missile variants (torpedo, FaF) add new `MissileWeaponDef`
  entries to the catalogue with their own tuning. `MissileSimulation`'s
  hot path reads all behavioural fields off `weaponDef`, so a new
  variant is data, not code.
- **L** — `MissileRecord` and `ProjectileRecord` both satisfy the
  position-step + sweep shape used by the collision primitives. The
  player + swarm sweep helpers are reused unchanged.
- **I** — The simulation's deps interface narrows each collaborator
  to the minimal surface it actually reads (`SwarmRecLookup` is just
  `get` + `all`, not the full `SwarmEntityRegistry`).
- **D** — `MissileSimulation` accepts injected `broadcastFired`,
  `broadcastDetonated`, `applyDamage`, `bus`, `swarmRegistry`,
  `getActiveShip`, `shipPoseCache`, `sabF32`. Trivially mockable in
  unit tests; the `tests/integration/sectorRoom/missileLifecycle.test.ts`
  exercises the full real-room wiring.

## Future work

- **Binary wire promotion** when sustained in-flight count crosses ~50.
  Spec: new `missileWireFormat.ts` (separate file, NOT a swarm-wire
  kind) + `MissileBroadcast.ts` + a `client.send('missile', buf)`
  channel; matches the bytes profile of `swarmWireFormat.ts` without
  contaminating the swarm pipeline.
- **Camera shake** on detonation, magnitude inverse to distance from
  camera with a `MIN_SHAKE_DIST` floor (prevents divide-by-zero at
  point-blank) and a `MAX_SHAKE` cap.
- **SFX hookup**: launch whoosh on `MISSILE_FIRED`, detonate boom on
  `pendingMissileExplosions` drain.
- **Particle trail** on missile sprites — pooled emit-rate-capped
  particles so a frigate's salvo doesn't tax the renderer's allocator.
- **Per-mount serial fire**: today both racks fire on the same tick
  when both finish cooldown together. A small stagger between L and R
  would read better visually; trivial to add by phasing
  `lastFireClientTick` per-mount.

## Files

- [src/shared-types/shipKinds/missileFrigate.ts](../../src/shared-types/shipKinds/missileFrigate.ts) — the ship-kind entry
- [src/core/combat/WeaponCatalogue.ts](../../src/core/combat/WeaponCatalogue.ts) — `HEAT_SEEKER_DEF` (`MissileWeaponDef` variant)
- [src/server/rooms/MissileSimulation.ts](../../src/server/rooms/MissileSimulation.ts) — the simulation itself
- [src/server/rooms/SectorRoom.ts](../../src/server/rooms/SectorRoom.ts) — wiring + impulse drain
- [src/server/rooms/SnapshotBroadcaster.ts](../../src/server/rooms/SnapshotBroadcaster.ts) — `missiles[]` AOI encode
- [src/server/rooms/PlayerFireResolver.ts](../../src/server/rooms/PlayerFireResolver.ts) + [AiFireResolver.ts](../../src/server/rooms/AiFireResolver.ts) — the `'missile'` mode branch
- [src/core/physics/worker.ts](../../src/core/physics/worker.ts) — `MISSILE_IMPULSE` command handler
- [src/shared-types/messages/missileMessages.ts](../../src/shared-types/messages/missileMessages.ts) — wire schemas
- [src/client/combat/MissileMirror.ts](../../src/client/combat/MissileMirror.ts) — snapshot apply + one-pose-per-frame seam
- [src/client/render/pixi/missileSpriteUpdater.ts](../../src/client/render/pixi/missileSpriteUpdater.ts) — per-frame sprite update + VFX drain
