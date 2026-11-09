/**
 * Fire control: does a barrel bear on its lock target? A mount fires only when
 * its barrel (world origin + world angle, game space, angle 0 = +Y) points
 * within FC_MOUNT_FIRE_TOLERANCE of the target. The server refuses any other
 * mount (PlayerFireResolver), and the client draws a predicted bolt only from
 * mounts that pass, so both sides use this one function (invariant #15).
 * Pure and allocation-free.
 */
export const FC_MOUNT_FIRE_TOLERANCE = 0.2;

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
