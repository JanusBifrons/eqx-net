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
  /** Lifetime in physics ticks; on expiry the missile detonates in-place
   *  (no `primaryTarget`, splash-only). */
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
  // 1.5 rad/s yaw clamp. A target moving perpendicular at 600 u/s needs
  // the missile to turn ~60°/s at 500u distance — 1.5 rad/s ≈ 86°/s,
  // so it CAN catch a target but a sustained dodge wins.
  turnRate: 1.5,
  splashRadius: 60,
  splashFalloffMin: 10,
  splashImpulse: 30,
  directImpulseBonus: 20,
  splashExcludeOwner: true,
  // Detonate when within ~60% of the splash radius of the locked target.
  // Lets dodged missiles still deliver a felt explosion rather than
  // sailing past uselessly.
  proximityFuseRadius: 36,
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
