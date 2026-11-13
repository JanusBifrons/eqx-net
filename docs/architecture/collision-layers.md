# Layered collision (shield circle ⇄ hull polygon)

How the shield/hull refactor works under the hood. Plan:
`.claude/plans/i-want-you-to-clever-wombat.md`. Commits: Phases 1–9 of
the `feat(shield)` series.

## The two collision representations

A ship body carries **one** of two collider shapes at a time:

- **shield up** → the shield bubble, `shipShieldColliderDesc(kind)`: a
  `ball(kind.radius + shipTuning(kind).shieldPad)` for every non-capital
  (a capital's is its hull rounded out by the pad). Ships colliding with
  their shields up impact each other's SHIELDS (owner's rule 2026-11-10),
  and the drawn bubble is this radius (`shieldBubbleRadius`). Players,
  freshly spawned drones (`World.spawnObstacle` with `shieldKind`, on the
  server worker AND the client predWorld) and regenerated shields all
  mount this ONE collider. Lock: `tests/unit/shieldColliderParity.test.ts`.
  (Before 2026-11-10 a fresh non-capital drone got a bare `ball(radius)`
  and the aura used a fixed 10 u pad, so the three disagreed.)
- **shield down** → a **compound of zero-density triangle colliders** —
  the exact rendered `ShipShape.points` ear-clipped into CCW triangles.

3 of 5 ship kinds are concave (scout/fighter/interceptor have a reflex
tail vertex). A convex hull would fill the notch and not match the
silhouette, so `src/core/geometry/triangulate.ts` does deterministic
ear-clipping (only `+ - * /` + cross-product sign, fixed ear order →
bit-identical Node↔Chromium, same guarantee as `asteroidShape.ts`). Per-
kind triangles are precomputed once at module load (catalogue is frozen —
zero per-tick / per-break allocation). The same triangle set feeds both
the Rapier compound collider and the pure weapon hit-test.

## The swap is dynamically transparent (mass model)

`PhysicsWorld.setHullExposed(id, exposed, kind)` removes the body's
collider(s) and rebuilds the other representation. **Every** ship/drone
collider is created with **density 0**; the body's entire mass + inertia
come from a one-time `setAdditionalMassProperties(m, (0,0), 0.5·m·r²)` —
the disc-equivalent the legacy density-ball produced. So the swap changes
**only contact/raycast geometry, never the dynamics** (player feel, drone
torque response, lockstep all identical regardless of shape). `spawnShip`
uses `m = 1`; `spawnObstacle`'s ball branch (drones/plain obstacles) uses
the `mass` arg — asteroids (the convexHull branch) keep real area-density
and never swap.

`recomputeMassPropertiesFromColliders()` **is** called after every
collider change (spawn + swap) and is **safe + required**: per
`@dimforge/rapier2d-compat` `rigid_body.d.ts:377/395` the effective total
is otherwise only refreshed at the next `world.step()`, so a pre-step
`applyImpulse` would see inverse-mass 0. "FromColliders" is a misnomer —
it recomputes the *total* = collider-contributions (0, zero-density) +
the stored additional props (= the pinned disc mass). NEVER reason about
it from the name; it includes the additional props.

**Query-pipeline lag:** the new geometry is visible to `castRay`/contact
generation only on the NEXT `world.step()`. The ≤1-tick window where a
query still sees the old (larger) circle after the shield dropped is
acceptable + intentional. Never paper over it with `updateSceneQueries()`
(the client predWorld won't, so doing so desyncs lockstep).

## Wire / authority

Shield + hull are **server-authoritative**. `src/core/combat/ShieldHull.ts`
is **server-authority-only** (unlike the shared `HostileDroneBehaviour`
brain): the client must never run the damage/regen functions — predicting
the 0-cross would flap the collider every RTT. The client only consumes
authoritative values.

- Players: `DamageEvent` gains `newShield/shieldMax/hullMax/hitLayer`
  (every hit). The regen ramp is **never streamed** — `ShieldEventMessage`
  fires only on the discrete transitions (`restored`, `regen_complete`);
  the client tweens the HUD bar between anchors via a CSS transition. No
  continuous shield traffic on any channel (locked design; matches the
  "pose lives off the schema" precedent). `ShipState.shield` /
  `shieldLastDamageTick` are **plain (non-`@type`) fields** — they die
  with the ship, zero cleanup sites, never serialised.
- Drones: `SWARM_RECORD_FLAG_SHIELD_DOWN = 1<<1` (spare bit in the
  existing `recordFlags` byte — **no stride change, no
  `SWARM_WIRE_VERSION` bump**), plus a `shieldDown?` bool on the snapshot
  `drones[]` slice. `SwarmEntityRecord.shieldDown` is maintained
  event-driven by `SectorRoom` at the drone shield 0-cross/restore.

The worker command is `SET_HULL_EXPOSED { id, exposed, kindId, tick }`
(`kindId` carried in the command — server-authoritative, no worker-side
kind map). Posted on the shield 0-cross (break) and 0-cross-up (regen
restore) for active player ships and drones.

## The cheap-circle-first perf guarantee

The weapon hit-test (`SectorRoom.playerHitscanDist` /
`playerProjectileSweep`) ALWAYS runs the cheap bounding-circle test
first. Circle miss ⇒ return null (the hull is strictly inside the
circle). Shield up ⇒ return the circle result **byte-identically** (zero
polygon work, no `shipCollisionTriangles` lookup). Only a circle-would-
hit **and** shield-down target pays the exact hull refinement (loop the
precomputed triangles via `rayHitsConvexPolygon` / a swept-segment
wrapper). `benchmarks/weapon-hittest.bench.ts` measures it: shield-up ≈
baseline, clear-miss ≈ baseline, shield-down ~2.5× **only on a near-pass**.

**Capitals are the exception: they always pay the hull refinement.** A
capital's shield follows its hull, and its circle is half the hull's
LENGTH (heavy cruiser 2,184 u vs a 227 u half beam). Until 2026-11-12 a
capital PILOT's ship (active, or parked by Spectate) with its shield up
returned the circle, so a broadside 16" shell burst ~2,000 u off its
side, in empty space. Pilot capitals now refine to the hull outline like
NPC capitals (`capitalHits.ts`, the pad not modelled), shield up or down;
the client's beam-end snap (`ColyseusClient.shieldEdgeDist`) does the
same (#15). Lock: `tests/integration/sectorRoom/capitalShieldHugsHull.test.ts`.

## Ramming aggregation (load-bearing)

A shield-down hull is N triangle colliders, so one physical ram emits up
to N contact-force sub-events sharing `{aId,bId}`. `src/core/combat/
Ramming.ts` sums force per **unordered pair per tick** BEFORE the floor +
damage curve + the (now single) `collision_resolved` broadcast — without
this, per-event damage would N-multiply (orientation-dependent) and a
hard ram could fall under the force floor split across triangles.
Asteroids deal but don't take (the no-health no-op falls out of
`applyDamage`).

### Damage curve — impact-based, ramming as a weapon (2026-11-13)

Replaced the 2026-06-12 mass-differential curve (WS-1 / R2.31), under which
two equal ships dealt nothing at any speed and the angle of the hit was
ignored. Owner: "You're telling me speed and angle of attack have no bearing?
Wtf?!", then chose an impact-based model in which ramming is a real attack.

```
vN             = closing speed along the contact normal (Contact.normalSpeed)
mu             = mA·mB / (mA + mB)                        (reduced mass)
E              = ½ · mu · max(0, vN − RAM_MIN_IMPACT_SPEED)²
damageTo(self) = min(RAM_DAMAGE_MAX,
                     RAM_DAMAGE_PER_ENERGY · E · mOther / (mSelf + mOther))
```

- **Angle matters.** `normalSpeed` is the pre-step relative velocity projected
  on Rapier's `maxForceDirection()` (the manifold normal, from body a to body
  b), the max over the pair's sub-contacts. Head-on ⇒ the whole closing speed;
  a scrape ⇒ |v|·sin(grazing angle).
- **Both ships are hurt, the lighter more.** The split is by weight: equal
  ships take equal damage, a fighter into a capital takes nearly all of it.
- **Physics note.** Two equal ships head-on at v each take what one would take
  hitting an immovable wall at v, so a fighter into a PARKED capital takes
  about a head-on's share; an oncoming capital adds its speed and crushes it.
- **Constants** (`Ramming.ts`): floor 50 u/s; `RAM_DAMAGE_PER_ENERGY` 1.25e-4
  (a full-speed fighter head-on at the 2× default scale ⇒ ~166 to each, 55 % of
  a fighter's 300 shield + hull); `RAM_DAMAGE_MAX` 400 per side per hit.
- **Pipeline unchanged.** Damage goes through `applyDamage` (shield first, then
  hull; the collider swaps on the shield 0-cross) and is rounded before the emit
  guard (P3.3). A shield-popping hit drops its overflow, as for any weapon, so a
  full-speed head-on takes exactly the fighter's shield in play.

Masses are the **folded Rapier body masses** (`World.getBodyMass`, threaded via
`Contact.aMass`/`bMass`); an absent mass deals nothing. Locks:
`src/core/combat/Ramming.test.ts` (shape: angle monotone, equal split,
lighter takes more, floor, ceiling, aggregation),
`src/core/physics/contactDrain.test.ts` (normal speed, head-on vs glancing) and
`tests/integration/sectorRoom/ramming.test.ts` (head-on fighters both lose a big
chunk; a glancing clip is small; fighter into crossguard). 🔴 netgate
(contact→damage live-loop).

## Body-lifecycle exposed-state

| transition | collider |
|---|---|
| spawn / respawn | shield full → circle (`exposed:false`) |
| sector transit (resetPredictionState despawn → respawn) | circle |
| shield → 0 | `SET_HULL_EXPOSED(true)` → polygon |
| shield 0 → >0 (regen) | `SET_HULL_EXPOSED(false)` → circle |
| lingering hull | keeps shield + regen (shield bookkeeping; player-body collider-swap deferred) |

## Drone lockstep — single-channel rule + the env-noise caveat

The drone client predWorld collider swap has **one ownership site**
(`syncSwarmIntoPredWorld`, driven by the decoded `entry.shieldDown`,
idempotent). The snapshot loop keeps `sw.shieldDown` consistent for
in-interest drones but does **not** add a second swap site (chapter-2
"one correction path per state surface"). A snapshot-anchored-channel
variant was prototyped and reverted — it introduced a spawn-gap that
regressed position p50.

`tests/e2e/feel-test-lockstep.spec.ts` is the dual-correction-path
canary (`swarmSnapP50<15`). It is a 6 s real-time AI sim and is **very
sensitive to host load**: during a long heavily-loaded dev session it
fails on *committed pre-shield code* too (baseline run: `swarmAngvelP99`
1.54, *worse* than this feature's 0.62 in the same session). It must be
read in a **quiet environment / CI**. The load-bearing lockstep signal
is position-`p50`; the angvel/angle p99 *tail* legitimately rises during
the bounded ~RTT shield-break transient (authoritative discrete collider
state + client prediction — corrected by the existing
`collision_resolved`/snapshot channels). Confirm green on a quiet host;
do not chase it on a loaded one.

## Deferred polish

Pixi shield-bubble visual + break/restore SFX were scoped out by the
user brief ("small but obvious for now, expand later"). Hooks exist
(`SHIELD_BROKEN`/`SHIELD_RESTORED` bus events, `shield_broken`/
`shield_restored` diagnostics, `entry.shieldDown` on the render mirror).
