/**
 * The held lock line (fire control): which target a pilot's line holds.
 * Shared by the client (picking the candidate under the line) and the server
 * (verifying a `lock_track` claim), invariant #15. Pure and alloc-free.
 *
 * The line runs from the pilot's ship along a world bearing (ship-angle
 * convention: forward = (-sin b, cos b)). A target is on it when it is ahead
 * of the ship, within the group's reach (with slack) and inside a cone that
 * widens with distance. The target the line already holds keeps it inside a
 * wider (sticky) cone, so a ship drifting across the line doesn't steal it.
 */

export const LOCK_LINE = {
  /** Cone half-width floor (u). */
  minTol: 70,
  /** Big targets widen the cone: `radius × radiusMul`. */
  radiusMul: 1.5,
  /** Cone growth per unit of distance along the line. */
  perAlong: 0.12,
  /** The held target's cone is this much wider. */
  stickyMul: 1.6,
  /** The line reaches this far past the group's reach. */
  reachSlack: 1.1,
  /** Tie-break weight: nearer targets win among equally centred ones. */
  alongWeight: 0.3,
} as const;

/**
 * Score of a target on the lock line (lower = better), or Infinity when the
 * line doesn't hold it. `dx`/`dy`: target minus ship; `dirX`/`dirY`: unit line
 * direction; `held`: the line already holds this target (sticky cone, score -1).
 */
export function lockLineScore(
  dx: number, dy: number, dirX: number, dirY: number, radius: number, reach: number, held: boolean,
): number {
  const along = dx * dirX + dy * dirY;
  if (along < 0 || along > reach * LOCK_LINE.reachSlack) return Infinity;
  const perp = Math.abs(dx * dirY - dy * dirX);
  const tol = (Math.max(LOCK_LINE.minTol, radius * LOCK_LINE.radiusMul) + along * LOCK_LINE.perAlong) * (held ? LOCK_LINE.stickyMul : 1);
  if (perp > tol) return Infinity;
  return held ? -1 : perp / tol + (along / Math.max(1e-6, reach)) * LOCK_LINE.alongWeight;
}

/**
 * Server check for a `lock_track` claim: is the target on the line the client
 * says it holds? Uses the sticky cone, which absorbs the client's display
 * delay and the bearing's quantisation.
 */
export function lockLineHolds(dx: number, dy: number, bearing: number, radius: number, reach: number): boolean {
  return Number.isFinite(lockLineScore(dx, dy, -Math.sin(bearing), Math.cos(bearing), radius, reach, true));
}
