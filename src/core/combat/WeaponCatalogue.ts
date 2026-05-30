export type WeaponMode = 'hitscan' | 'projectile' | 'missile';
export type WeaponId = 'hitscan' | 'laser' | 'heat-seeker';

interface WeaponDefBase {
  id: WeaponId;
  displayName: string;
  mode: WeaponMode;
  damage: number;
  cooldownTicks: number;
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
  damage: 20,
  cooldownTicks: 10,
  range: 500,
};

const LASER_DEF: ProjectileWeaponDef = {
  id: 'laser',
  displayName: 'Laser',
  mode: 'projectile',
  damage: 10,
  cooldownTicks: 10,
  speed: 1600,
  radius: 3,
  maxTicks: 90,
};

const HEAT_SEEKER_DEF: MissileWeaponDef = {
  id: 'heat-seeker',
  displayName: 'Heat-Seeker',
  mode: 'missile',
  // Direct-hit damage. The primary target also gets `directImpulseBonus`
  // additive damage on top of the splash component; near-miss splash
  // damage uses the inverse-square falloff against `damage` alone.
  damage: 30,
  // 180 ticks = ~3 s per mount cooldown. The frigate has 2 mounts that
  // fire on the same trigger, so the salvo cadence is one pair every 3 s.
  // Long enough that a single in-flight missile can engage + commit
  // before the next salvo launches, keeping the airspace from
  // saturating; short enough that pursuit-fire is still expressive.
  cooldownTicks: 180,
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
