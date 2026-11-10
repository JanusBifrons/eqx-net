/**
 * Naval gun ballistics in ABSOLUTE world units (plan: real-scale naval ranges,
 * slice 1). Unlike the sub-capital weapons, the `naval_*` guns are NOT scaled
 * by the ship-scale combat profile (`combatDistanceScale`): capital hulls are
 * built unscaled, so their guns are too. The numbers below are the ones the
 * shipped game (2× B, reach ×1.5) already used, so this is a no-op there.
 *
 * Lives in shared-types (pure, leaf zone) so both the weapon catalogue
 * (`core/combat/WeaponCatalogue.ts`) and the coastal-defence structure records
 * (`structureKinds.ts`, which may not import core) read ONE source.
 */

/** Auto-fire engages a projectile target only within this fraction of the
 *  bolt's full travel (`weaponAutoFireRange`'s projectile rule). */
export const PROJECTILE_ENGAGE_FRAC = 0.85;

/** A projectile's engage reach: its max travel × `PROJECTILE_ENGAGE_FRAC`. */
export function projectileEngageReach(speed: number, maxTicks: number): number {
  return ((speed * maxTicks) / 60) * PROJECTILE_ENGAGE_FRAC;
}

export interface NavalGunBallistics {
  /** Shell speed, world units per second. */
  readonly speed: number;
  /** Shell flight time, ticks (60 Hz). */
  readonly maxTicks: number;
}

/** Shell speed and flight time per naval gun, absolute (never profile-scaled). */
export const NAVAL_GUN_BALLISTICS = {
  naval_s: { speed: 1800, maxTicks: 90 },
  naval_m: { speed: 2000, maxTicks: 125 },
  naval_l: { speed: 2200, maxTicks: 156 },
  naval_xl: { speed: 2300, maxTicks: 165 },
  naval_xxl: { speed: 2600, maxTicks: 210 },
  naval_siege: { speed: 1900, maxTicks: 240 },
} as const satisfies Record<string, NavalGunBallistics>;

export type NavalGunId = keyof typeof NAVAL_GUN_BALLISTICS;

/** Schwerer Gustav's blast, absolute (the shipped 2× B value). */
export const NAVAL_SIEGE_SPLASH = { radius: 320, falloffMin: 60 } as const;

/** A naval gun's engage reach, rounded to the unit: a coastal structure's
 *  `weaponRange` (the range ring and the defence check). Equals
 *  `Math.round(weaponAutoFireRange(getWeapon(id)))`. */
export function navalGunEngageReach(id: NavalGunId): number {
  const b = NAVAL_GUN_BALLISTICS[id];
  return Math.round(projectileEngageReach(b.speed, b.maxTicks));
}
