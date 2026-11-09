/**
 * Target-lock TUNING DATA (exp/fire-control P1). Every number that decides how
 * long a lock takes lives here, so balance changes never touch logic. Shared by
 * the server (authority) and the client (ring prediction), #15.
 *
 * The model (see core/combat/lockTime.ts):
 *   seconds = base
 *           × size      (weapon reference size vs target signature)
 *           × tracking  (target's angular rate across the weapon vs its tracking)
 *           × range     (further = slower)
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
  /** A lock beyond this many seconds is impossible (shown "can't lock"). */
  maxSeconds: number;
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
 */
export const WEAPON_LOCK_PROFILE: Record<MountSize | 'none', { refSize: number; tracking: number }> = {
  none: { refSize: 40, tracking: 2.5 },
  AA: { refSize: 40, tracking: 2.0 },
  S: { refSize: 120, tracking: 0.9 },
  M: { refSize: 600, tracking: 0.35 },
  L: { refSize: 1200, tracking: 0.2 },
  XL: { refSize: 1800, tracking: 0.15 },
};

/** Hull sensor quality by size class (higher = faster locks). */
export const SENSOR_BY_CLASS: Record<string, number> = {
  default: 1.0,
  capital: 0.85,
};

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
