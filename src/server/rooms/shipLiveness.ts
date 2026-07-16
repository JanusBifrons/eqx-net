/**
 * Shared ship-liveness predicates (campaign PR 2.2; invariant #17).
 *
 * A ship is exactly ONE of: ACTIVE (a session is piloting it), LINGERING
 * (alive but parked — disconnected / displaced / spectator-parked,
 * `isActive=false`), or DEAD (`alive=false`). Every per-ship subsystem loop
 * must gate on a NAMED predicate for the classes it covers — never an
 * improvised mix of `ship.alive`, `ship.isActive`, and map-membership
 * checks. The 2026-07 review found the improvised gates had diverged:
 * shield regen ran for lingering hulls (gated `alive` only) while the
 * collider restore in the same loop gated `isActive` — a parked hull
 * regenerated an INVISIBLE shield its physics body didn't have.
 */

/** The liveness slice a predicate needs — structural, so ShipState and test
 *  stubs both satisfy it. */
export interface ShipLivenessView {
  alive: boolean;
  isActive: boolean;
}

/** ACTIVE: a live hull a session is piloting. The gate for subsystems that
 *  only make sense under a pilot: shield regen, energy regen/drain, mount
 *  aiming, AI targeting visibility. */
export function isPilotedActive(ship: ShipLivenessView): boolean {
  return ship.alive && ship.isActive;
}

/** LINGERING: a live hull parked in-world with no session driving it. It
 *  keeps whatever shield/energy it parked with (no regen — regen resumes on
 *  reclaim), stays damageable, and is visible/selectable. */
export function isLingeringHull(ship: ShipLivenessView): boolean {
  return ship.alive && !ship.isActive;
}
