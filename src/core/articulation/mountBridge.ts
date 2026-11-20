/**
 * Mount bridge (structure-restyle 2a, plan §5): a weapon mount riding on a
 * rig part, e.g. a pop-up turret = a lift part (no in-plane motion) carrying
 * the existing mount, or a deploy slide part that moves it out.
 *
 * The bridge only supplies the mount's PARENT FRAME: the part's pose composed
 * with the host's world pose. Existing mount maths that takes a host pose
 * `(x, y, angle)` plus the mount's `localX/localY` (`setTractorMuzzle`,
 * `mayBeInReach`, muzzle helpers) is called with this frame instead, and the
 * mount's `localX/localY` are then read in the part's frame. The mount ANGLE
 * is still written only by `WeaponMountController.tickSlot` (invariant #12),
 * relative to `frame.angle`; nothing here touches it.
 */
import type { RigPose } from './evaluate.js';

/** A world frame: origin and facing. Caller-owned scratch. */
export interface PartFrame {
  x: number;
  y: number;
  angle: number;
}

/** Write the world frame of part `partIndex` on a host at (hostX, hostY)
 *  facing `hostAngle`, from an evaluated pose. Allocation-free. */
export function partWorldFrame(
  pose: RigPose, partIndex: number, hostX: number, hostY: number, hostAngle: number, out: PartFrame,
): PartFrame {
  const c = Math.cos(hostAngle), s = Math.sin(hostAngle);
  const px = pose.x[partIndex]!, py = pose.y[partIndex]!;
  out.x = hostX + px * c - py * s;
  out.y = hostY + px * s + py * c;
  out.angle = hostAngle + pose.angle[partIndex]!;
  return out;
}

/** World anchor (pivot) of a mount whose `localX/localY` are in the frame of
 *  part `partIndex`. `out.angle` is the mount's parent frame angle (the mount
 *  angle from `tickSlot` is relative to it). Allocation-free. */
export function mountAnchorOnPart(
  pose: RigPose, partIndex: number, hostX: number, hostY: number, hostAngle: number,
  mount: { readonly localX: number; readonly localY: number }, out: PartFrame,
): PartFrame {
  partWorldFrame(pose, partIndex, hostX, hostY, hostAngle, out);
  const c = Math.cos(out.angle), s = Math.sin(out.angle);
  const fx = out.x, fy = out.y;
  out.x = fx + mount.localX * c - mount.localY * s;
  out.y = fy + mount.localX * s + mount.localY * c;
  return out;
}
