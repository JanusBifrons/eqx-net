import { rotateMountToward, wrapPi } from '@core/ai/WeaponMountController';
import type { WeaponMount } from '@shared-types/shipKinds';

export interface MountAimTarget {
  x: number;
  y: number;
}

/**
 * Slew the local player's per-mount turret angles toward `target`,
 * writing the result **CATALOGUE-INDEXED** into `out` — one entry per
 * `catalogueMounts[i]`, in `kind.mounts` order.
 *
 * ## Why catalogue order is load-bearing (the latent index bug)
 *
 * `ShipRenderState.mountAngles` is indexed by catalogue mount-order
 * EVERYWHERE it is READ:
 *   - the live-beam direction in `PixiRenderer` reads
 *     `mountAngles[localKind.mounts.findIndex(m => m.id === mountId)]`;
 *   - the turret sprites read it via `shipSpriteUpdater` →
 *     `MountVisualManager.applyMountAngles(id, kind.mounts, mountAngles)`
 *     which iterates `kind.mounts[i]` and reads `mountAngles[i]`.
 *
 * The local-player WRITER (`ColyseusClient.tickLocalMountAim`) used to
 * size + index this array by the ACTIVE SLOT's mounts
 * (`resolveSlotMounts`, slot-local order). That is only correct while a
 * slot is the full catalogue in catalogue order — which is true for
 * every gameplay ship TODAY (one slot = all mounts). The moment a slot
 * is a subset or reorder of `kind.mounts`, the slot-local write index
 * diverges from the catalogue read index and the local player's beams +
 * turrets read the WRONG mount's angle (or `undefined` → base). Remote
 * players were always fine (the server writes the snapshot
 * catalogue-indexed). This helper makes the local write match the reads.
 *
 * `activeMountIds` is the set of mount ids in the player's active weapon
 * slot — only those mounts aim at the target; every other catalogue
 * mount slews back to base (0, barrel forward). For the single-slot
 * ships shipping today (`activeMountIds` == every catalogue id) this is
 * behaviour-identical to the old "aim all slot mounts" loop.
 *
 * Allocation-free: mutates `out` in place (caller owns the array, sized
 * to `catalogueMounts.length`). Safe in the `tickPhysics` hot loop
 * (invariant #14). Composes the pure core primitives `rotateMountToward`
 * + `wrapPi` (invariant #12 — the sanctioned client local-aim path).
 */
export function tickLocalMountAngles(
  out: number[],
  catalogueMounts: ReadonlyArray<WeaponMount>,
  activeMountIds: ReadonlySet<string>,
  target: MountAimTarget | null,
  shipX: number,
  shipY: number,
  shipAngle: number,
  dtSec: number,
): void {
  const cosA = Math.cos(shipAngle);
  const sinA = Math.sin(shipAngle);
  for (let ci = 0; ci < catalogueMounts.length; ci++) {
    const mount = catalogueMounts[ci]!;
    // Default desired bearing = base (0): a mount that isn't firing, or
    // has no target, slews back to forward.
    let desired = 0;
    if (target !== null && activeMountIds.has(mount.id)) {
      // Mount pivot in world space, then world bearing to the target,
      // rotated into the mount's arc-local frame (same convention as
      // ship.angle: forward = -y, right = +x → atan2(-dx, dy)).
      const mountWorldX = shipX + (mount.localX * cosA - mount.localY * sinA);
      const mountWorldY = shipY + (mount.localX * sinA + mount.localY * cosA);
      const worldBearing = Math.atan2(-(target.x - mountWorldX), target.y - mountWorldY);
      desired = wrapPi(worldBearing - shipAngle - mount.baseAngle);
    }
    out[ci] = rotateMountToward(out[ci] ?? 0, desired, mount, dtSec);
  }
}
