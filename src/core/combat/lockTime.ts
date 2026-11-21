/**
 * How long a target lock takes (exp/fire-control P1). Pure, alloc-free, and
 * shared by the server (authoritative lock progress) and the client (the ring
 * it draws ahead of the snapshot), #15. All tuning numbers come from
 * shared-types/combat/lockProfile.ts.
 */
import { LOCK_TUNING, type LockTuning } from '../../shared-types/combat/lockProfile.js';

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
  /** Shooter + target radius (u): lock range is measured hull to hull
   *  (bounding circles), so a 2.9 km battleship locks and is locked like a
   *  fighter. Absent = 0 (a per-mount lock measures from its mount). */
  hullRadii?: number;
}

/** The target is past lock range (`t.maxLockRange`, hull to hull: centre
 *  offset (dx, dy) less `hullRadii`). The one lock-range test: `lockSeconds`,
 *  `capLockSeconds`, the lock line and NPC locks all ask it (#15). */
export function pastLockRange(dx: number, dy: number, hullRadii: number, t: LockTuning = LOCK_TUNING): boolean {
  const r = t.maxLockRange + hullRadii;
  return dx * dx + dy * dy > r * r;
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
 * Seconds to lock, or Infinity when the target can't be locked (no weapon, or
 * too small / fast for the weapon: the reach-share time is past `maxSeconds`,
 * unless `t.clampAtMax`, which takes `maxSeconds` instead).
 *
 * Lock range (owner 2026-11-21, "for now"): past `t.maxLockRange` (1 km,
 * hull to hull, `pastLockRange`) nothing locks, whatever the gun's reach (Infinity, so a
 * held lock breaks after the grace window). Inside it there is no reach gate:
 * distance only makes a lock slower (the range term). A small gun's
 * reach-share term saturates at its reach (`min(1, range / reach)`), so past
 * reach it locks as at the edge of reach and the `maxSeconds` "can't track"
 * test reads size and crossing speed only.
 *
 * Heavy mounts (`i.absRange`) then swap the reach-share range term for the
 * ABSOLUTE one (`absRangeTerm`): distance makes their lock slower, never
 * impossible, and is not capped (owner, 2026-11-10: "It should take ages to
 * lock, that's by design").
 *
 * A SHIP's heavy gun (`i.absRange` under ship tuning, i.e. not
 * `t.clampAtMax`) skips the `maxSeconds` gate: a small or fast target only
 * makes its lock slower (owner 2026-11-10: a 16" on a fighter "10 minutes or
 * an hour ... working as intended"). Who flies the ship plays no part: player
 * and NPC ships take this one path (owner 2026-11-13: "It's the same ship and
 * the same gun, so it gets the same lock"). Fixed batteries (`clampAtMax`,
 * structures) keep their own rule: the size/speed part caps at `maxSeconds`.
 */
export function lockSeconds(i: LockInputs, t: LockTuning): number {
  const range = Math.sqrt(i.dx * i.dx + i.dy * i.dy);
  if (!(i.reach > 0) || pastLockRange(i.dx, i.dy, i.hullRadii ?? 0, t)) return Infinity;
  const sizeRatio = i.signature > 0 ? i.refSize / i.signature : Infinity;
  const sizeTerm = sizeRatio > 1 ? Math.pow(sizeRatio, t.sizeExp) : 1;
  const ang = angularRate(i.dx, i.dy, i.dvx, i.dvy);
  const trackRatio = i.tracking > 0 ? ang / i.tracking : Infinity;
  const trackTerm = 1 + t.trackFactor * trackRatio * trackRatio;
  const rangeTerm = 1 + t.rangeFactor * Math.min(1, range / i.reach);
  const speed = Math.max(1e-6, i.sensor * i.pilotSpeed);
  let secs = (t.baseSeconds * sizeTerm * trackTerm * rangeTerm) / speed;
  if (!Number.isFinite(secs)) return Infinity;
  if (secs > t.maxSeconds && !(i.absRange && !t.clampAtMax)) {
    if (!t.clampAtMax) return Infinity;
    secs = t.maxSeconds;
  }
  return i.absRange ? (secs * absRangeTerm(range, t)) / rangeTerm : secs;
}

/**
 * testMode `lockTimeCapS` (a room option, bespoke test/recording trigger): no
 * NON-player lock takes longer than `capS` seconds inside lock range; 0
 * completes it on the first lock step. Lock-to-fire stays universal: a lock is
 * still acquired, only faster. A lock the rules call too slow to lock at all
 * (past `maxSeconds` on a sub-capital gun) or very slow (a 16" gun on a
 * fighter) locks in `capS` too, so a shot can start with every gun locked; a
 * shooter with no weapon (`reach` 0) or a target past `t.maxLockRange` never
 * locks. `capS` undefined = the rules unchanged.
 */
export function capLockSeconds(secs: number, i: LockInputs, capS: number | undefined, t: LockTuning = LOCK_TUNING): number {
  if (capS === undefined) return secs;
  if (!(i.reach > 0) || pastLockRange(i.dx, i.dy, i.hullRadii ?? 0, t)) return Infinity;
  return Number.isNaN(secs) ? capS : Math.min(secs, capS);
}
