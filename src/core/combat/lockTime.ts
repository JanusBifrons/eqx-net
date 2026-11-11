/**
 * How long a target lock takes (exp/fire-control P1). Pure, alloc-free, and
 * shared by the server (authoritative lock progress) and the client (the ring
 * it draws ahead of the snapshot), #15. All tuning numbers come from
 * shared-types/combat/lockProfile.ts.
 */
import type { LockTuning } from '../../shared-types/combat/lockProfile.js';

export interface LockInputs {
  /** The weapon's reference target size (u) — what it is built to hit. */
  refSize: number;
  /** The weapon's comfortable tracking rate (rad/s). */
  tracking: number;
  /** The weapon's reach (u). */
  reach: number;
  /** Shooter hull sensor quality (1 = baseline). */
  sensor: number;
  /** Pilot lock-speed multiplier (1 = none). */
  pilotSpeed: number;
  /** Target signature (u, its hull radius). */
  signature: number;
  /** Target position relative to the shooter (u). */
  dx: number;
  dy: number;
  /** Target velocity relative to the shooter (u/s). */
  dvx: number;
  dvy: number;
  /** Heavy mount (M/L/XL, `WEAPON_LOCK_PROFILE[size].absRange`): the range
   *  term reads absolute distance, not the share of reach. Absent = false. */
  absRange?: boolean;
  /** PLAYER heavy gun (only with `absRange`): a lock past `maxSeconds` is
   *  slow, never impossible; it keeps its finite, uncapped time (owner,
   *  2026-11-10: a 16" on a fighter "10 minutes or an hour ... working as
   *  intended"). Only the player `LockSubsystem` sets it: NPC main guns rely
   *  on Infinity to skip small craft. Absent = false. */
  neverImpossible?: boolean;
}

/** The heavy-mount range term: 1 + (range ÷ absRangeScale)^absRangeExp. */
export function absRangeTerm(range: number, t: LockTuning): number {
  return 1 + Math.pow(range / t.absRangeScale, t.absRangeExp);
}

/** Angular rate (rad/s) of the target across the shooter's view. */
export function angularRate(dx: number, dy: number, dvx: number, dvy: number): number {
  const r2 = dx * dx + dy * dy;
  if (r2 < 1) return 0;
  return Math.abs(dx * dvy - dy * dvx) / r2;
}

/**
 * Seconds to lock, or Infinity when the target can't be locked (out of reach,
 * or too small / fast for the weapon: the reach-share time is past
 * `maxSeconds`, unless `t.clampAtMax`, which takes `maxSeconds` instead).
 *
 * Heavy mounts (`i.absRange`) then swap the reach-share range term for the
 * ABSOLUTE one (`absRangeTerm`): distance makes their lock slower, never
 * impossible, and is not capped (owner, 2026-11-10: "It should take ages to
 * lock, that's by design").
 *
 * A PLAYER heavy gun (`i.absRange && i.neverImpossible`) skips the
 * `maxSeconds` gate: a small or fast target only makes its lock slower.
 */
export function lockSeconds(i: LockInputs, t: LockTuning): number {
  const range = Math.sqrt(i.dx * i.dx + i.dy * i.dy);
  if (!(i.reach > 0) || range > i.reach * t.reachSlack) return Infinity;
  const sizeRatio = i.signature > 0 ? i.refSize / i.signature : Infinity;
  const sizeTerm = sizeRatio > 1 ? Math.pow(sizeRatio, t.sizeExp) : 1;
  const ang = angularRate(i.dx, i.dy, i.dvx, i.dvy);
  const trackRatio = i.tracking > 0 ? ang / i.tracking : Infinity;
  const trackTerm = 1 + t.trackFactor * trackRatio * trackRatio;
  const rangeTerm = 1 + t.rangeFactor * Math.min(1, range / i.reach);
  const speed = Math.max(1e-6, i.sensor * i.pilotSpeed);
  let secs = (t.baseSeconds * sizeTerm * trackTerm * rangeTerm) / speed;
  if (!Number.isFinite(secs)) return Infinity;
  if (secs > t.maxSeconds && !(i.absRange && i.neverImpossible)) {
    if (!t.clampAtMax) return Infinity;
    secs = t.maxSeconds;
  }
  return i.absRange ? (secs * absRangeTerm(range, t)) / rangeTerm : secs;
}

/** The target is within the weapon's lock reach (`reach × reachSlack`). */
export function lockInReach(i: LockInputs, t: LockTuning): boolean {
  if (!(i.reach > 0)) return false;
  return Math.sqrt(i.dx * i.dx + i.dy * i.dy) <= i.reach * t.reachSlack;
}

/**
 * testMode `lockTimeCapS` (a room option, bespoke test/recording trigger): no
 * NON-player lock takes longer than `capS` seconds; 0 completes it on the
 * first lock step. Lock-to-fire stays universal: a lock is still acquired,
 * only faster. A target out of reach stays unlockable (Infinity); one in
 * reach that the rules call too slow to lock at all (past `maxSeconds`, e.g.
 * a 16" gun on a fighter) locks in `capS` too, so a shot can start with every
 * gun locked. `capS` undefined = the rules unchanged.
 */
export function capLockSeconds(secs: number, i: LockInputs, t: LockTuning, capS: number | undefined): number {
  if (capS === undefined) return secs;
  if (!lockInReach(i, t)) return Infinity;
  return Number.isNaN(secs) ? capS : Math.min(secs, capS);
}
