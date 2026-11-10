/**
 * Target-lock TUNING DATA (exp/fire-control P1). Every number that decides how
 * long a lock takes lives here, so balance changes never touch logic. Shared by
 * the server (authority) and the client (ring prediction), #15.
 *
 * The model (see core/combat/lockTime.ts):
 *   seconds = base
 *           × size      (weapon reference size vs target signature)
 *           × tracking  (target's angular rate across the weapon vs its tracking)
 *           × range     (further = slower: share of reach for small guns,
 *                        ABSOLUTE distance for heavy M/L/XL mounts)
 *           ÷ sensor    (shooter hull's sensors)
 *           ÷ pilot     (later: skills / stat allocation)
 *   above `maxSeconds` → can't lock (Infinity).
 *
 * Neutral / allied targets first run a FAILSAFE ring `failsafeMul` × longer;
 * letting it finish is a hostile act.
 */
import type { ShipKind } from '../shipKinds/types.js';

/** A mount's size class (WeaponMountSchema.size). */
export type MountSize = 'AA' | 'S' | 'M' | 'L' | 'XL';

export interface LockTuning {
  /** Seconds for a matched weapon/target at point-blank, sitting still. */
  baseSeconds: number;
  /** A released (let-go) lock drains at this × its build rate. */
  decayMul: number;
  /** Exponent on (weapon reference size ÷ target signature) when > 1. */
  sizeExp: number;
  /** Weight of (angular rate ÷ tracking)² — fast crossers are hard to lock. */
  trackFactor: number;
  /** Extra multiple at the very edge of reach (linear in range ÷ reach). */
  rangeFactor: number;
  /** Heavy mounts (`WEAPON_LOCK_PROFILE[size].absRange`): the range term is
   *  1 + (range ÷ absRangeScale)^absRangeExp, on ABSOLUTE distance (u). */
  absRangeScale: number;
  /** Exponent of the absolute range term: > 1 so long shots take ages. */
  absRangeExp: number;
  /** A lock beyond this many seconds is impossible (shown "can't lock").
   *  Judged on size, speed and the reach-share range term only: absolute
   *  distance (heavy mounts) makes a lock slower, never impossible. */
  maxSeconds: number;
  /** Fixed batteries: a lock past `maxSeconds` takes `maxSeconds` instead of
   *  being impossible (a heavy mount then still stretches it for distance). */
  clampAtMax?: boolean;
  /** Failsafe ring duration multiple for neutral / allied targets. */
  failsafeMul: number;
  /** A locked/acquiring target may be out of reach this long before it drops. */
  lostGraceSeconds: number;
  /** Locks start/persist out to reach × this (a small grace band). */
  reachSlack: number;
}

export const LOCK_TUNING: LockTuning = {
  baseSeconds: 1.5,
  decayMul: 1.5,
  sizeExp: 0.6,
  trackFactor: 1.5,
  rangeFactor: 0.6,
  // Heavy mounts: 1 + (range / 7000)^1.5. At today's 3–5k u capital
  // engagements this matches the reach-share term within ~5 %; at 30k u it
  // is ~9.9 (a 16" on a battleship ≈ 17 s, on a destroyer ≈ 22 s).
  absRangeScale: 7000,
  absRangeExp: 1.5,
  maxSeconds: 8,
  failsafeMul: 1.75,
  lostGraceSeconds: 1.5,
  reachSlack: 1.1,
};

/**
 * Each weapon size's REFERENCE target size (u) and TRACKING (rad/s it can
 * follow comfortably). A gun built for capitals (XL) finds a fighter-sized
 * signature tiny and slow to resolve, and can't follow a fast crosser; the
 * quad AA is built for exactly that. `none` = small-craft guns.
 * `absRange`: the range term reads ABSOLUTE distance (heavy capital and
 * coastal guns: a 30 km shot takes ages to lock) instead of the share of the
 * gun's reach. Sub-capital and fighter guns keep the reach share.
 */
export const WEAPON_LOCK_PROFILE: Record<MountSize | 'none', { refSize: number; tracking: number; absRange: boolean }> = {
  none: { refSize: 40, tracking: 2.5, absRange: false },
  AA: { refSize: 40, tracking: 2.0, absRange: false },
  S: { refSize: 120, tracking: 0.9, absRange: false },
  M: { refSize: 600, tracking: 0.35, absRange: true },
  L: { refSize: 1200, tracking: 0.2, absRange: true },
  XL: { refSize: 1800, tracking: 0.15, absRange: true },
};

/** Hull sensor quality by size class (higher = faster locks). */
export const SENSOR_BY_CLASS: Record<string, number> = {
  default: 1.0,
  capital: 0.85,
};

/**
 * Sensor quality of a defence structure's fire control (coastal guns, quad
 * AA, plain turrets). A fixed installation carries a bigger director than a
 * hull, so its heavy guns can still lock a capital near their reach (an XL
 * gun on a 190 u capital at full reach takes ~9 s at sensor 1, past
 * `maxSeconds`; ~6 s here).
 */
export const STRUCTURE_SENSOR = 1.5;

/** Lock-queue size defaults: sub-capitals hold 1 target per group, capitals 3. */
export const LOCK_CAPACITY_DEFAULT = 1;
export const LOCK_CAPACITY_CAPITAL = 3;

/** A pilot's lock modifiers (identity until skills / stats feed it). */
export interface PilotLockMods {
  /** Multiplies lock speed (2 = twice as fast). */
  lockSpeed: number;
  /** Adds to every group's lock capacity. */
  extraLocks: number;
}
export const NO_PILOT_MODS: PilotLockMods = { lockSpeed: 1, extraLocks: 0 };

export function sensorFor(kind: Pick<ShipKind, 'sizeClass'>): number {
  return SENSOR_BY_CLASS[kind.sizeClass ?? 'default'] ?? SENSOR_BY_CLASS['default']!;
}

/** A target's lock signature (u): its hull radius. */
export function signatureFor(kind: Pick<ShipKind, 'radius'>): number {
  return kind.radius;
}

/** How many targets a group can hold. Slot override → class default, + pilot. */
export function lockCapacityFor(
  kind: Pick<ShipKind, 'sizeClass'>,
  slot: { lockCapacity?: number } | undefined,
  pilot: PilotLockMods = NO_PILOT_MODS,
): number {
  const base = slot?.lockCapacity ?? (kind.sizeClass === 'capital' ? LOCK_CAPACITY_CAPITAL : LOCK_CAPACITY_DEFAULT);
  return Math.max(1, base + pilot.extraLocks);
}
