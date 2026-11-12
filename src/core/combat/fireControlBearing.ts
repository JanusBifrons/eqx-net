/**
 * Fire control: does a barrel bear on its lock target? A mount fires only when
 * its barrel (world origin + world angle, game space, angle 0 = +Y) points
 * within FC_MOUNT_FIRE_TOLERANCE of the target. The server refuses any other
 * mount (PlayerFireResolver), and the client draws a predicted bolt only from
 * mounts that pass, so both sides use this one function (invariant #15).
 * Pure and allocation-free.
 */
import { NAVAL_SHELL_WEAPON_IDS } from './shellFlight.js';
import { TURRET_FIRE_MISS, TURRET_FIRE_TOLERANCE } from './mountFireControl.js';

export const FC_MOUNT_FIRE_TOLERANCE = 0.2;

/**
 * The bearing window for a player mount firing `weaponId` at a target `dist`
 * away. Naval shell guns use the turret rule every NPC capital and coastal gun
 * uses (`mountFireControl`): within TURRET_FIRE_TOLERANCE AND a shot passing
 * within TURRET_FIRE_MISS of the target. A flat 0.2 rad let a player's 16"
 * turret fire while still training, ~6 km wide at 30 km (owner, 2026-11-12:
 * "the rear cannons missing by miles"). Everything else keeps
 * FC_MOUNT_FIRE_TOLERANCE (a fighter's fixed guns fire inside their nose cone).
 */
export function mountFireTolerance(weaponId: string, dist: number): number {
  if (!NAVAL_SHELL_WEAPON_IDS.has(weaponId)) return FC_MOUNT_FIRE_TOLERANCE;
  return Math.min(TURRET_FIRE_TOLERANCE, Math.atan2(TURRET_FIRE_MISS, dist));
}

/** `barrelBearsOn` with the window for the mount's weapon (`mountFireTolerance`).
 *  Both sides' player fire gates call this (#15). */
export function mountBearsOn(
  weaponId: string,
  ox: number,
  oy: number,
  angle: number,
  tx: number,
  ty: number,
): boolean {
  const dx = tx - ox;
  const dy = ty - oy;
  return barrelBearsOn(ox, oy, angle, tx, ty, mountFireTolerance(weaponId, Math.sqrt(dx * dx + dy * dy)));
}

export function barrelBearsOn(
  ox: number,
  oy: number,
  angle: number,
  tx: number,
  ty: number,
  tolerance: number = FC_MOUNT_FIRE_TOLERANCE,
): boolean {
  const want = Math.atan2(-(tx - ox), ty - oy);
  let d = want - angle;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  return Math.abs(d) <= tolerance;
}
