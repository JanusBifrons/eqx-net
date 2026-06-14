export type WeaponMode = 'hitscan' | 'projectile' | 'missile';
export type WeaponId = 'hitscan' | 'laser' | 'heat-seeker';

interface WeaponDefBase {
  id: WeaponId;
  displayName: string;
  mode: WeaponMode;
  damage: number;
  cooldownTicks: number;
  /** Energy drained from the firing ship's pool per SLOT trigger (NOT per
   *  mount). A slot's effective cost is the MAX of its mounts' `energyCost`
   *  (homogeneous slots collapse to a single value; the interceptor's twin
   *  beams cost one beam-slot's energy, not 2×). Drones are NOT energy-gated
   *  — this field is read only on the player fire path. See
   *  `src/core/combat/Energy.ts` and `docs/plans/weapons-energy-ai-overhaul.md`
   *  §3. */
  energyCost: number;
}

export interface HitscanWeaponDef extends WeaponDefBase {
  mode: 'hitscan';
  range: number;
  /** Optional "optimal + beyond" damage falloff. `range` is the OPTIMAL
   *  range: FULL `damage` out to it. BEYOND it, applied damage falls LINEARLY
   *  to `minDamageFrac × damage` at `range × maxRangeMul` — the max reach
   *  the ray casts to; past that there is no hit. `maxRangeMul` defaults to 1
   *  (no beyond-optimal band ⇒ flat full damage everywhere in range). Absent
   *  falloff ⇒ flat damage. SERVER-AUTHORITATIVE — the client reads the scaled
   *  number off the `DamageEvent`, never predicts it (avoids desync). */
  falloff?: { minDamageFrac: number; maxRangeMul?: number };
}

export interface ProjectileWeaponDef extends WeaponDefBase {
  mode: 'projectile';
  speed: number;
  radius: number;
  maxTicks: number;
}

/** Heat-seeking missile weapon. Locked at launch via `pickTarget`, chases the
 *  target until it dies/leaves range or the missile expires. Slow speed +
 *  wide turn radius so players can dodge. On impact: inverse-square splash
 *  damage + kinetic impulse via the physics worker's `MISSILE_IMPULSE`
 *  command. See docs/architecture/missile-simulation.md. */
export interface MissileWeaponDef extends WeaponDefBase {
  mode: 'missile';
  /** Linear speed (units/sec). Slow enough to be dodgeable — 400 at 60Hz
   *  ≈ 6.67 u/tick, well below ship-radius 12 so no tunneling. */
  speed: number;
  /** Collision radius for direct-hit sweep. */
  radius: number;
  /** Lifetime in physics ticks. On expiry the missile is despawned
   *  WITHOUT detonating (impact-only — smoke handoff 2026-06-06, Issue 2):
   *  a missile that never hits fizzles out, it does not splash in-place.
   *  The cap still exists so a never-hitting missile doesn't fly forever. */
  lifetimeTicks: number;
  /** Maximum homing yaw clamp (rad/sec). Wider turn radius = dodgeable. */
  turnRate: number;
  /** Splash damage falloff radius. Damage falls off as `(splashFalloffMin/dist)²`
   *  inside this radius; zero outside. */
  splashRadius: number;
  /** Inner clamp on `dist` so the inverse-square doesn't divide by zero
   *  at point-blank. Damage at `dist <= splashFalloffMin` is exactly `damage`. */
  splashFalloffMin: number;
  /** Peak kinetic impulse magnitude (at `splashFalloffMin`). Falls off with
   *  the same inverse-square as damage. */
  splashImpulse: number;
  /** Extra damage applied to a primary (directly-struck or proximity-fused)
   *  target on top of the splash component. */
  directImpulseBonus: number;
  /** Skip the owner ship during splash damage/impulse (defaults true). */
  splashExcludeOwner: boolean;
  /** Detonate when within this radius of the locked target. Allows near-miss
   *  detonations to feel meaningful (dodgeable but not useless). Set to 0 to
   *  disable proximity-fusing (direct-hit-only behaviour). */
  proximityFuseRadius: number;
}

export type WeaponDef = HitscanWeaponDef | ProjectileWeaponDef | MissileWeaponDef;

const HITSCAN_DEF: HitscanWeaponDef = {
  id: 'hitscan',
  displayName: 'Beam',
  mode: 'hitscan',
  // Server-side fire cadence stays at 6 Hz (cooldownTicks=10 @ 60 Hz =
  // 167 ms inter-shot). The first smooth-beam retune (2026-05-22) tried
  // 4 HP × 33 ms to make the feel continuous, but it scaled DRONE fire
  // identically (the server uses one catalogue for both) and the 5×
  // wire-event amplification (laser_fired + damage broadcasts per
  // shooter × 25 drones in a populated sector) re-triggered the
  // 110 ms compositor stall pattern on touch devices — capture
  // `o4n4pw` 2026-05-22 vs `iph9cv` baseline. Reverted to keep wire
  // load low; the smooth feel is now produced CLIENT-SIDE via visual
  // damage-number splitting in `ColyseusClient.sendFire` (one server
  // fire → N small predicted ticks spread across the cooldown window,
  // tagged with the same `clientShotId` so existing
  // `reconcileDamageToFeedback` / `cancelByTag` handle the
  // confirmation / rollback unchanged). Wire load = baseline. Feel =
  // smooth. Drones + players use the same code path.
  //
  // Weapons/energy/AI overhaul (2026-06-01, plan:
  // weapons-energy-ai-overhaul §2): the BEAM is now the interceptor's
  // very-close-range duellist. Range dropped 500 → 250 (knife-fight
  // distance); per-beam damage 20 → 13 so a single-beam ship would kill
  // a 300-HP fighter in ~4 s at 6 Hz while the interceptor's TWIN beams
  // (two mounts, one slot trigger) land that in ~2 s — its "high DPS,
  // low hull" identity. NOTE: drones share this catalogue, and the
  // weapon-aware drone fire range in `HostileDroneBehaviour` derives
  // from this `range` for beam drones (close-in attackers).
  damage: 13,
  cooldownTicks: 10,
  range: 250,
  // "optimal + beyond", LINEAR (Equinox laser issue, 2026-06-14): FULL 13 damage
  // out to the 250 u OPTIMAL range, then a LINEAR drop-off to 15 % (≈2) at
  // maxRange = 250×1.3 = 325 u (where the ray ends). maxRangeMul tightened
  // 1.5 → 1.3 so the beam's beyond-optimal fringe is a SHORT, clearly-terminating
  // tail that fades to nothing well within view — the 1.5× (375 u) tail ran to the
  // screen edge and read as "renders infinitely". The CLIENT beam visual taper
  // (BeamSpritePool) draws solid to optimal then fades to nothing across
  // optimal→maxRange, so the visible taper == this damage band. Tunable;
  // server-authoritative (client reads the scaled damage off DamageEvent).
  falloff: { minDamageFrac: 0.15, maxRangeMul: 1.3 },
  // Beam slot trigger cost — interceptor full-pool sustain ≈ 6 s
  // (energyMax 180 / (5 × 6 Hz)). One slot trigger drains 5 regardless
  // of the twin mounts.
  energyCost: 5,
};

const LASER_DEF: ProjectileWeaponDef = {
  id: 'laser',
  displayName: 'Bolt',
  mode: 'projectile',
  // Weapons/energy/AI overhaul (2026-06-01, §2): BOLTS are the workhorse
  // for scout / fighter / heavy / gunship. Medium range, dodgeable, ~4 s
  // kill on a 300-HP fighter at 6 shots/s ⇒ ~25 hits ⇒ damage 12. Range
  // = speed × maxTicks / 60 = 1600 × 42 / 60 ≈ 1120 u (medium; was 2400).
  damage: 12,
  cooldownTicks: 10,
  speed: 1600,
  radius: 3,
  maxTicks: 42,
  // Bolt slot trigger cost — full-pool sustain 10-15 s for bolt ships
  // (e.g. scout energyMax 120 / (2 × 6 Hz) = 10 s).
  energyCost: 2,
};

const HEAT_SEEKER_DEF: MissileWeaponDef = {
  id: 'heat-seeker',
  displayName: 'Heat-Seeker',
  mode: 'missile',
  // Direct-hit damage. The primary target also gets `directImpulseBonus`
  // additive damage on top of the splash component; near-miss splash
  // damage uses the inverse-square falloff against `damage` alone.
  //
  // Weapons/energy/AI overhaul (2026-06-01, §2): MISSILES kill most ships
  // in 1-2 hits. A salvo = 2 missiles (one slot trigger). With no-spillover
  // shields, one 150-damage missile is fully absorbed by a ≤150 shield
  // (dropping it to 0); the second lands on hull — so a 2-missile salvo
  // kills the common ≤300-HP ships (scout/fighter/interceptor). Was 30.
  damage: 150,
  // 90 ticks = ~1.5 s per mount cooldown (was 180/3 s). Sized so the
  // salvo cadence sustains ~8 missiles in flight over the 6 s TTL
  // (≈4 salvos / 6 s), the reverse-engineered "8 in flight" target
  // (plan §3.4). The frigate's energy pool + steady regen pace the real
  // throughput; cooldown is the floor.
  cooldownTicks: 90,
  // Missile slot trigger cost — frigate energyMax 240 / 60 = ~4-salvo
  // opening burst, then regen-paced (energyRegenRate 0.67 × 90 ticks ≈
  // one slot cost per cooldown window). Costs once at launch; no refund,
  // no in-flight cap (plan §3.4).
  energyCost: 60,
  // 400 u/s = 6.67 u/tick. Dodgeable but not slow enough to be a joke.
  speed: 400,
  // Collision radius small; missile is a point-thing visually.
  radius: 4,
  // 360 ticks = 6 s lifetime. Range at top speed ≈ 2400 u (well past
  // hitscan beam range of 500). Long enough to make dumb-mode missiles
  // a meaningful waste-of-shot.
  lifetimeTicks: 360,
  // 1.5 rad/s yaw clamp (playtest 2026-06-10 Issue 10: "missiles should bias
  // tracking the closest enemy a lot more" → tighter homing). Turn radius =
  // speed/turnRate = 400/1.5 ≈ 267 u (was 400 u at 1.0). Paired with mid-flight
  // re-acquisition in MissileSimulation.advance (a lost lock re-chases the
  // nearest hostile instead of flying straight forever) — together they make
  // missiles meaningfully track. Was briefly 1.0 (smoke 2026-06-06 dodgeability
  // pass); the playtest found that, combined with no re-acquisition, missiles
  // felt useless. A turning target can still out-manoeuvre at 1.5; this is a
  // gameplay knob — revisit after the next playtest. Do NOT confuse with the
  // frigate MOUNT rotationSpeed (turret slew) in shipKinds/missileFrigate.ts.
  turnRate: 1.5,
  splashRadius: 60,
  splashFalloffMin: 10,
  splashImpulse: 30,
  directImpulseBonus: 20,
  splashExcludeOwner: true,
  // Impact-only (smoke handoff 2026-06-06, Issue 2: "make it only explode
  // on impact"). 0 disables the proximity fuse → only a direct sweep hit
  // (`advance()` step 5) detonates; a near-miss flies past without
  // exploding. Splash still applies on a real hit. Paired with the
  // non-damaging lifetime expiry in MissileSimulation.advance() step 6.
  proximityFuseRadius: 0,
};

export const WEAPONS: ReadonlyMap<WeaponId, WeaponDef> = new Map<WeaponId, WeaponDef>([
  ['hitscan', HITSCAN_DEF],
  ['laser', LASER_DEF],
  ['heat-seeker', HEAT_SEEKER_DEF],
]);

export const WEAPON_IDS: readonly WeaponId[] = ['hitscan', 'laser', 'heat-seeker'] as const;

export const DEFAULT_WEAPON: WeaponId = 'hitscan';

export function getWeapon(id: WeaponId): WeaponDef {
  return WEAPONS.get(id) ?? HITSCAN_DEF;
}

export function isWeaponId(v: unknown): v is WeaponId {
  return v === 'hitscan' || v === 'laser' || v === 'heat-seeker';
}

/**
 * Maximum range (world units) at which auto-fire should engage a target with
 * this weapon. Per-mode so each weapon "shoots when in its own reach":
 *
 *   - hitscan:    the beam's `range` (instant, exact).
 *   - projectile: `speed * maxTicks / 60` (the bolt's max travel) × 0.85 so
 *     auto-fire only opens up where the bolt can realistically still land
 *     before its lifetime expires (a target at the very edge usually drifts
 *     out before the bolt arrives).
 *   - missile:    `speed * lifetimeTicks / 60` × 0.5 — homing missiles can
 *     reach much farther, but auto-firing them at full lifetime range wastes a
 *     scarce, expensive salvo on shots likely to be dodged/expire; cap engage
 *     range to half the theoretical reach.
 *
 * Pure + allocation-free (scalar in/out) — safe to call in the fire-decision
 * hot path. The exhaustive `never` default makes a future weapon mode a
 * compile error rather than a silent `undefined`.
 */
export function weaponAutoFireRange(def: WeaponDef): number {
  switch (def.mode) {
    case 'hitscan':
      return def.range;
    case 'projectile':
      return ((def.speed * def.maxTicks) / 60) * 0.85;
    case 'missile':
      return ((def.speed * def.lifetimeTicks) / 60) * 0.5;
    default: {
      const _exhaustive: never = def;
      return _exhaustive as never;
    }
  }
}

/**
 * "Optimal + beyond" hitscan damage falloff fraction in [minDamageFrac, 1].
 * FULL (1.0) out to `optimalRange`, then falling LINEARLY in the normalized
 * over-optimal distance to `minDamageFrac` at `maxRange`, clamped to
 * `minDamageFrac` past it. Pure + allocation-free (scalar in/out) — safe on the
 * fire-resolution path. Multiply the weapon's flat `damage` by this to get the
 * distance-scaled damage. A degenerate band (`maxRange <= optimalRange`) yields
 * 1.0 = flat full damage.
 *
 * LINEAR (Equinox laser issue, 2026-06-14; supersedes the P3.13 reverse-square).
 * The user's decision: a constant fall per unit of over-range distance reads as a
 * smooth, predictable taper that matches the visual beam taper — the reverse-
 * square's "slow then cliff" convex shape felt like damage "drops to 0 almost
 * instantly beyond range". Equal-width sub-bands now drop equal amounts.
 */
export function hitscanFalloffFrac(dist: number, optimalRange: number, maxRange: number, minDamageFrac: number): number {
  if (dist <= optimalRange) return 1;
  if (maxRange <= optimalRange) return 1;
  if (dist >= maxRange) return minDamageFrac;
  const t = (dist - optimalRange) / (maxRange - optimalRange);
  const frac = 1 - (1 - minDamageFrac) * t;
  return frac < minDamageFrac ? minDamageFrac : frac > 1 ? 1 : frac;
}
