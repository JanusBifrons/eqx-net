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
}

/** Angular rate (rad/s) of the target across the shooter's view. */
export function angularRate(dx: number, dy: number, dvx: number, dvy: number): number {
  const r2 = dx * dx + dy * dy;
  if (r2 < 1) return 0;
  return Math.abs(dx * dvy - dy * dvx) / r2;
}

/**
 * Seconds to lock, or Infinity when the target can't be locked (out of reach,
 * or the lock would take longer than `maxSeconds`).
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
  const secs = (t.baseSeconds * sizeTerm * trackTerm * rangeTerm) / speed;
  return secs > t.maxSeconds || !Number.isFinite(secs) ? Infinity : secs;
}
