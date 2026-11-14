/**
 * Fire control: may a mount fire at its lock target? Only when the target's
 * hit shape is within the mount's own reach, measured from the mount
 * (`mountInReach`, the one per-mount range gate), and its barrel (world origin + world angle, game
 * space, angle 0 = +Y) points within FC_MOUNT_FIRE_TOLERANCE of the target
 * (`mountFiresOn` = both). The server refuses any other
 * mount (PlayerFireResolver), and the client draws a predicted bolt only from
 * mounts that pass, so both sides use this one function (invariant #15).
 * Pure and allocation-free.
 */
import { NAVAL_SHELL_WEAPON_IDS } from './shellFlight.js';
import { TURRET_FIRE_MISS, TURRET_FIRE_TOLERANCE } from './mountFireControl.js';
import { mountInReach, type MountRangeTarget } from './mountReach.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

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

/**
 * What the fire gate needs of a lock target: its pose and its hit shape. Both
 * sides fill it from data they already hold (#15): a ship (`ship`, any pilot)
 * by its kind, heading and whether its shield is up; anything else
 * (structures) by `radius`. `radius` is also the lock signature (a ship: its
 * kind's radius, which the range gate ignores for a ship's true hull). The
 * range half is the `MountRangeTarget` every turret shares (`mountInReach`).
 */
export interface FireTargetShape extends MountRangeTarget {
  x: number;
  y: number;
  angle: number;
  ship: boolean;
  kindId: string | null;
  shieldUp: boolean;
  radius: number;
}

/** A blank `FireTargetShape` (scratch; allocate once, fill per call). */
export function newFireTargetShape(): FireTargetShape {
  return { x: 0, y: 0, angle: 0, ship: false, kindId: null, shieldUp: false, radius: 0 };
}

/**
 * Fill `out` for a target at (x, y, angle). THE one fill both sides use (#15):
 * the server's `SectorRoom.resolveLockTarget` (swarm record / pilot ship) and
 * the client's `fcTargetPose` (swarm wire / ship mirror). A ship (any pilot)
 * keeps its kind and shield and takes its kind's radius (its lock signature); anything
 * else keeps `radius` (a structure's).
 */
export function fillFireTargetShape(
  out: FireTargetShape, x: number, y: number, angle: number,
  ship: boolean, kindId: string | null, shieldUp: boolean, radius: number,
): void {
  out.x = x;
  out.y = y;
  out.angle = angle;
  out.ship = ship;
  out.kindId = ship ? kindId : null;
  out.shieldUp = shieldUp;
  out.radius = ship ? getShipKind(kindId).radius : radius;
}

/**
 * THE player fire gate for one mount: the target is within the mount's reach
 * (`mountInReach` from the mount to the hit shape) AND its barrel bears on it (`mountBearsOn`). The
 * server's `PlayerFireResolver` (via `SectorRoom.mountBearsOnLock`) and the
 * client's fire passes (`fcGroupBears`, `fcFireMounts`, the ghost gate) all
 * call this (#15, #19).
 */
export function mountFiresOn(
  weaponId: string,
  reach: number,
  ox: number,
  oy: number,
  angle: number,
  t: FireTargetShape,
): boolean {
  return mountInReach(t.x - ox, t.y - oy, reach, t) && mountBearsOn(weaponId, ox, oy, angle, t.x, t.y);
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
