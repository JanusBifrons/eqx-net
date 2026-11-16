/**
 * Turret fire control, shared by every turret that picks its own target and
 * fires on its own reload (plan coastal-defences): capital ship mounts
 * (`server/rooms/WeaponMountTicker.tickCapitalMounts`) and defence
 * structures (`server/structures/StructureMountTicker`). One set of rules, so
 * a 16" gun on a battleship and a 16" coastal barbette behave the same:
 *
 *  - ENGAGE: the target's hull is within the gun's reach of the mount, inside the mount's arc
 *    (a casemate's embrasure, a deck turret's training limits) and slow
 *    enough across its sights to track (`canTrack`).
 *  - LEAD: aim at the first-order intercept for the gun's shell speed, on
 *    the target's velocity relative to the shooter.
 *  - FIRE: only when the barrel would put the shot within `TURRET_FIRE_MISS`
 *    of the aim point (an angle alone is a 250 u miss at 5,000 u) AND a ray
 *    down the barrel hits the target's hit shape there (`barrelRayHits`):
 *    a miss allowance wider than a small ship let a wide beam fire beside
 *    it and graze it with its edge.
 *
 * Angles use the mount convention: a body's frame angle (game space, Y-up,
 * CCW), bearing 0 = +y, `atan2(-dx, dy)`. Pure, allocation-free.
 */
import { wrapPi } from '../ai/WeaponMountController.js';
import { canTrack } from './mountTargeting.js';
import { mountInReach, type MountRangeTarget } from './mountReach.js';
import { shipRayHit } from './shipHitShape.js';

/** A turret fires once its barrel is within this of the lead bearing (rad)
 *  AND would pass within TURRET_FIRE_MISS (world units) of the aim point. */
export const TURRET_FIRE_TOLERANCE = 0.05;
export const TURRET_FIRE_MISS = 60;

/** The arc limits and traverse rate a mount is judged by. */
export interface FireControlMount {
  readonly baseAngle: number;
  readonly arcMin: number;
  readonly arcMax: number;
  readonly rotationSpeed: number;
}

/** Bearing of offset (dx, dy) in the mount's arc-local frame. */
export function arcLocalBearing(dx: number, dy: number, frameAngle: number, baseAngle: number): number {
  return wrapPi(Math.atan2(-dx, dy) - frameAngle - baseAngle);
}

/** Is offset (dx, dy) inside the mount's arc? A full-circle arc always is. */
export function inMountArc(m: FireControlMount, frameAngle: number, dx: number, dy: number): boolean {
  if (m.arcMax - m.arcMin >= 2 * Math.PI - 1e-6) return true;
  const local = arcLocalBearing(dx, dy, frameAngle, m.baseAngle);
  return local >= m.arcMin && local <= m.arcMax;
}

/** Can the mount engage a target at offset (dx, dy) moving at (rvx, rvy)
 *  relative to it: in reach (measured to the nearest point of the target's
 *  hit shape `target`, `mountInReach`; absent = its centre), in arc and
 *  trackable? Hostility and line of fire are the caller's (they depend on
 *  what the shooter is). */
export function mountCanEngage(
  m: FireControlMount, frameAngle: number, dx: number, dy: number, reach: number, rvx: number, rvy: number,
  target?: MountRangeTarget | null,
): boolean {
  if (!mountInReach(dx, dy, reach, target)) return false;
  if (!inMountArc(m, frameAngle, dx, dy)) return false;
  return canTrack(m.rotationSpeed, dx, dy, rvx, rvy);
}

/** Arc-local bearing to lead a target at offset (dx, dy) moving at (rvx, rvy)
 *  relative to the mount, for a shell of `shellSpeed` (0 = instant, no lead). */
export function leadArcBearing(
  dx: number, dy: number, rvx: number, rvy: number, shellSpeed: number, frameAngle: number, baseAngle: number,
): number {
  const lead = shellSpeed > 0 ? Math.hypot(dx, dy) / shellSpeed : 0;
  return arcLocalBearing(dx + rvx * lead, dy + rvy * lead, frameAngle, baseAngle);
}

/** Is a barrel at arc-local `current` on target for `want` at range `dist`? */
export function onTarget(want: number, current: number, dist: number): boolean {
  const tol = Math.min(TURRET_FIRE_TOLERANCE, Math.atan2(TURRET_FIRE_MISS, Math.max(1, dist)));
  return Math.abs(wrapPi(want - current)) <= tol;
}

/**
 * Does a thin ray from (fromX, fromY) along the barrel's world bearing
 * `worldAngle` (mount convention: 0 = +y) hit target `t` placed at its aim
 * point (aimX, aimY) (its lead point for a shell gun)? A ship is tested on its
 * hull polygon (`shipRayHit` with the shield down, whatever its shield); any
 * other target on its `radius` circle. A target with no shape (no kind, no
 * radius) passes: `onTarget` alone gates it. A turret starts firing only once
 * a ray down its barrel would hit (owner: "a basic ray trace").
 */
export function barrelRayHits(
  t: MountRangeTarget, aimX: number, aimY: number, fromX: number, fromY: number, worldAngle: number, maxDist: number,
): boolean {
  const ux = -Math.sin(worldAngle), uy = Math.cos(worldAngle);
  if (t.kindId != null) {
    // The HULL, shield or not: a ray through the edge of a small ship's
    // shield bubble (68 u on a frigate) still drew the beam beside the ship.
    return shipRayHit(t.kindId, false, fromX, fromY, ux, uy, maxDist, aimX, aimY, t.angle ?? 0, 0) !== null;
  }
  const r = t.radius ?? 0;
  if (r <= 0) return true;
  const px = aimX - fromX, py = aimY - fromY;
  const along = px * ux + py * uy;
  if (along < -r || along > maxDist + r) return false;
  return Math.abs(px * uy - py * ux) <= r;
}
