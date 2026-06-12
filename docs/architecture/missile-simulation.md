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
   │                   │     ├── integrate position          │
   │                   │     ├── sweep player + swarm        │
   │                   │     ├── lifetime decrement          │
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

## Asteroids are solid — missiles detonate, never pass through (WS-2b / R2.22)

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
