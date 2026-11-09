/**
 * Turret fire control, shared by every turret that picks its own target and
 * fires on its own reload (plan coastal-defences): capital ship mounts
 * (`server/rooms/WeaponMountTicker.tickCapitalMounts`) and defence
 * structures (`server/structures/StructureMountTicker`). One set of rules, so
 * a 16" gun on a battleship and a 16" coastal barbette behave the same:
 *
 *  - ENGAGE: the target is within the gun's reach, inside the mount's arc
 *    (a casemate's embrasure, a deck turret's training limits) and slow
 *    enough across its sights to track (`canTrack`).
 *  - LEAD: aim at the first-order intercept for the gun's shell speed, on
 *    the target's velocity relative to the shooter.
 *  - FIRE: only when the barrel would put the shot within `TURRET_FIRE_MISS`
 *    of the aim point (an angle alone is a 250 u miss at 5,000 u).
 *
 * Angles use the mount convention: a body's frame angle (game space, Y-up,
 * CCW), bearing 0 = +y, `atan2(-dx, dy)`. Pure, allocation-free.
 */
import { wrapPi } from '../ai/WeaponMountController.js';
import { canTrack } from './mountTargeting.js';

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
 *  relative to it: in reach, in arc and trackable? Hostility and line of fire
 *  are the caller's (they depend on what the shooter is). */
export function mountCanEngage(
  m: FireControlMount, frameAngle: number, dx: number, dy: number, reach: number, rvx: number, rvy: number,
): boolean {
  if (dx * dx + dy * dy > reach * reach) return false;
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
