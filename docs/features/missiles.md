# Heat-Seeking Missiles + Missile Frigate

The first homing weapon in EQX Peri. Adds a new ship class (Missile
Frigate) and a new weapon (heat-seeker) that together change the
combat feel from "dogfight at hitscan range" to "artillery duel with
dodging".

## Player-facing behaviour

**Missile Frigate** is roughly twice the size of every other ship in
the catalogue. It turns sluggishly (≈ 46 °/s vs. the Heavy's 80 °/s,
the Scout's 200+ °/s) and is the slowest hull in the fleet (max speed
600 u/s vs. 800–950 elsewhere). What it gets in exchange is the deepest
hull (500 HP + 400 shield), the most distinctive silhouette, and twin
forward heat-seeker racks.

**Heat-seekers** behave like dodgeable artillery:

- **Lock-at-launch**: the missile picks a target at launch time, using
  the same sticky-target selection drones use for their guns. The
  target id stays server-internal — the client never sees it. After
  launch the missile commits to whatever it locked onto; if the target
  dies or leaves the sector, the missile keeps flying straight until it
  expires.
- **Slow + dodgeable**: 400 u/s top speed (vs. 1600 u/s for a laser
  bolt), 1.5 rad/s yaw clamp. A sustained dodge can outrun a heat-
  seeker; a stationary or oblivious target will be tracked.
- **Proximity fuse**: detonates when within ~36 units of the locked
  target. A "miss" that flies *past* a dodging ship by a hair's breadth
  still delivers a felt explosion (just diminished damage and impulse
  per the inverse-square falloff).
- **Splash + impulse**: on detonation, damage and kinetic impulse fall
  off as 1/r² from the blast centre out to a 60-unit splash radius. A
  direct hit pushes the target hard; a near-miss bumps it off course.
  Bonus damage (+20) lands on the directly-struck (or proximity-fused)
  target on top of the splash.
- **Lifetime**: 6 seconds of pursuit. A heat-seeker that runs out of
  fuel detonates in place — splash-only, no primary target.

## Mounts

The Missile Frigate carries **two** heat-seeker racks:
- `rack-l` at local (-10, -8)
- `rack-r` at local (+10, -8)

Both sit in the `primary` slot, so pulling the trigger fires both racks
on the same tick (a tight stagger emerges from server-tick scheduling).
With the missile's 110-tick cooldown that's ~0.9 s between salvos when
both racks fire at once, or up to ~1.8 s per individual mount.

## Cooldown math

Missile per-mount cooldown is 110 ticks (≈ 1.83 s at 60 Hz). With the
frigate's two mounts firing on the same trigger pull, sustained DPS is
~33 damage/sec at the primary target plus splash damage to bystanders.
At single-target peak (proximity-fused direct hits), `damage` (30) +
`directImpulseBonus` (20) = 50 per missile, so the two-rack salvo
delivers up to 100 burst damage on a stationary target.

## How to use one

In the spawn galaxy map, pick `Missile Frigate` from the ship roster
(or spawn one via the dev tools). Hold W to thrust; the chassis builds
speed slowly. Use turn keys to orient the racks toward a target you
want to lock — the racks have only ±15° of mount-track, so the chassis
has to point roughly at the target before firing. Press the fire key:
the racks lock, the missiles launch, and from that point the missile
does the steering. Heat-seekers are best at range — the slow speed
and wide turn radius mean a brawler can sometimes evade them; the
artillery profile rewards engaging at the edge of beam range.

## Counterplay

If you're on the receiving end:
- **Move.** A sustained perpendicular dodge can outrun the missile's
  yaw clamp.
- **Get close.** Once a Missile Frigate is inside ~100 units, the
  proximity-fuse threshold makes evading new missiles harder, but the
  frigate's slow turn rate means you can stay on its blind spots.
- **Kill the frigate.** It's the deepest hull in the game, but slow and
  sluggish; under sustained beam fire it dies before it can clear the
  cooldown on a second salvo.

## See also

- [docs/architecture/missile-simulation.md](../architecture/missile-simulation.md)
  — internals: server-side pool layout, lock-at-launch + id-reuse
  safety, splash-impulse math, the JSON snapshot wire path, and the
  physics-worker impulse dispatch.
- [src/shared-types/shipKinds/missileFrigate.ts](../../src/shared-types/shipKinds/missileFrigate.ts)
  — the catalogue entry with the full tuning numbers.
- [src/core/combat/WeaponCatalogue.ts](../../src/core/combat/WeaponCatalogue.ts)
  — the `HEAT_SEEKER_DEF` weapon definition (`MissileWeaponDef`
  variant).
