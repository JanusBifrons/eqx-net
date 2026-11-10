/**
 * Naval gun ballistics in ABSOLUTE world units (plan: real-scale naval ranges,
 * slice 1). Unlike the sub-capital weapons, the `naval_*` guns are NOT scaled
 * by the ship-scale combat profile (`combatDistanceScale`): capital hulls are
 * built unscaled, so their guns are too.
 *
 * Two tables, picked by the naval range switch (`navalRange.ts`,
 * `EQX_NAVAL_RANGE` / `?navalRange=`): `legacy` (default) is what the shipped
 * game (2× B, reach ×1.5) always used; `real` is the real maximum range in the
 * game's km with time of flight real ÷ 3 (slice 14).
 *
 * Lives in shared-types (pure, leaf zone) so both the weapon catalogue
 * (`core/combat/WeaponCatalogue.ts`) and the coastal-defence structure records
 * (`structureKinds.ts`, which may not import core) read ONE source.
 */
import { NAVAL_RANGE, type NavalRangeMode } from './navalRange.js';

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

/** LEGACY shell speed and flight time per naval gun (`EQX_NAVAL_RANGE` unset
 *  or `legacy`): the shipped 2× B numbers, absolute. */
export const LEGACY_NAVAL_GUN_BALLISTICS = {
  naval_s: { speed: 1800, maxTicks: 90 },
  naval_m: { speed: 2000, maxTicks: 125 },
  naval_l: { speed: 2200, maxTicks: 156 },
  naval_xl: { speed: 2300, maxTicks: 165 },
  naval_xxl: { speed: 2600, maxTicks: 210 },
  naval_siege: { speed: 1900, maxTicks: 240 },
} as const satisfies Record<string, NavalGunBallistics>;

export type NavalGunId = keyof typeof LEGACY_NAVAL_GUN_BALLISTICS;

/**
 * REAL ranges (owner decision 2026-11-10, `EQX_NAVAL_RANGE=real`): each gun's
 * real maximum range in the game's km (1 km = 1,000 u, as the warp map counts)
 * and its real time of flight to that range (docs/research/
 * ww2-surface-combatants.md, ww2-coastal-defences.md). The game flies it in a
 * third of the time (`REAL_FLIGHT_COMPRESSION`).
 */
export const REAL_NAVAL_GUNS = {
  naval_s: { reachU: 16_600, realFlightS: 58 }, // 5"/38
  naval_m: { reachU: 25_500, realFlightS: 72 }, // 8"
  naval_l: { reachU: 35_000, realFlightS: 84 }, // 12"/50
  naval_xl: { reachU: 38_700, realFlightS: 90 }, // 16"/50 (Iowa)
  naval_xxl: { reachU: 56_000, realFlightS: 107 }, // 40.6 cm SK C/34 (Lindemann)
  naval_siege: { reachU: 47_000, realFlightS: 98 }, // 80 cm Schwerer Gustav
} as const satisfies Record<NavalGunId, { reachU: number; realFlightS: number }>;

/** Game time of flight = real time of flight ÷ this. */
export const REAL_FLIGHT_COMPRESSION = 3;

/**
 * Real-range ballistics. The ENGAGE reach (what a gun locks and fires at, the
 * range ring, a coastal `weaponRange`) is the real maximum range. Speed =
 * reach ÷ (real flight ÷ 3), so a shell reaches a target at max range in a
 * third of the real time. The shell then keeps flying: `maxTicks` is the
 * flight to max range ÷ `PROJECTILE_ENGAGE_FRAC` (~18 % more, rounded up), the
 * same 0.85 engage rule as every other projectile, so a target at max range
 * that opens the distance is still reached. A miss never bursts at the end.
 */
function realBallistics(id: NavalGunId): NavalGunBallistics {
  const g = REAL_NAVAL_GUNS[id];
  const speed = Math.round((g.reachU * REAL_FLIGHT_COMPRESSION) / g.realFlightS);
  const maxTicks = Math.ceil(((g.reachU / speed) * 60) / PROJECTILE_ENGAGE_FRAC);
  return { speed, maxTicks };
}

/** naval_s 859 u/s × 1365 t · naval_m 1063 × 1694 · naval_l 1250 × 1977 ·
 *  naval_xl 1290 × 2118 · naval_xxl 1570 × 2518 · naval_siege 1439 × 2306. */
export const REAL_NAVAL_GUN_BALLISTICS: Readonly<Record<NavalGunId, NavalGunBallistics>> = {
  naval_s: realBallistics('naval_s'),
  naval_m: realBallistics('naval_m'),
  naval_l: realBallistics('naval_l'),
  naval_xl: realBallistics('naval_xl'),
  naval_xxl: realBallistics('naval_xxl'),
  naval_siege: realBallistics('naval_siege'),
};

/** The ballistics table for a naval range mode. */
export function navalGunBallisticsFor(mode: NavalRangeMode): Readonly<Record<NavalGunId, NavalGunBallistics>> {
  return mode === 'real' ? REAL_NAVAL_GUN_BALLISTICS : LEGACY_NAVAL_GUN_BALLISTICS;
}

/** Shell speed and flight time per naval gun for THIS process's
 *  `NAVAL_RANGE`, absolute (never profile-scaled). */
export const NAVAL_GUN_BALLISTICS: Readonly<Record<NavalGunId, NavalGunBallistics>> = navalGunBallisticsFor(NAVAL_RANGE);

/** Schwerer Gustav's blast, absolute (the shipped 2× B value). The same in
 *  both range modes: it is a blast radius, not a range (how far a 7 t shell
 *  was fired doesn't change the crater it digs). */
export const NAVAL_SIEGE_SPLASH = { radius: 320, falloffMin: 60 } as const;

/** A naval gun's engage reach, rounded to the unit: a coastal structure's
 *  `weaponRange` (the range ring and the defence check). Equals
 *  `Math.round(weaponAutoFireRange(getWeapon(id)))` for this process's mode. */
export function navalGunEngageReach(id: NavalGunId, mode: NavalRangeMode = NAVAL_RANGE): number {
  const b = navalGunBallisticsFor(mode)[id];
  return Math.round(projectileEngageReach(b.speed, b.maxTicks));
}
