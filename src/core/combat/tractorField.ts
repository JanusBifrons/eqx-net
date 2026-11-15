/**
 * One tractor field from one mount (salvage plan PR 11b): the server's lease
 * (`ForceFieldSubsystem`) and the client's prediction world
 * (`client/net/tractorLinks.ts`) both build their `TractorForceField` here,
 * so the two sides run the same pull (#15). Allocation-free.
 */
import type { TractorForceField } from '../physics/forceFields.js';
import type { WeaponMount } from '../../shared-types/shipKinds.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { getWeapon } from './WeaponCatalogue.js';
import { mountWeaponReach } from './mountReach.js';

/**
 * The per-mount constants of `f` from the mount's tractor weapon: force ×
 * the mount size's power, reach, the falloff, cushion and beam-line numbers.
 * Returns false (and leaves `f` alone) when the mount carries no tractor.
 */
export function setTractorMountConstants(
  f: TractorForceField, mount: Pick<WeaponMount, 'weaponId' | 'size'>,
): boolean {
  const spec = getWeapon(mount.weaponId).tractor;
  if (spec === undefined) return false;
  f.force = spec.force * MOUNT_SIZE_TUNING[mount.size ?? 'S'].power;
  f.reach = mountWeaponReach(mount);
  f.dRef = spec.dRef;
  f.hold = spec.hold;
  f.lineHalfWidth = spec.lineHalfWidth;
  f.lineFrac = spec.lineFrac;
  return true;
}

/** The field's muzzle (`mx`, `my`): the mount's world origin on an emitter
 *  at (x, y) facing `angle`. */
export function setTractorMuzzle(
  f: TractorForceField, x: number, y: number, angle: number, mount: Pick<WeaponMount, 'localX' | 'localY'>,
): void {
  const c = Math.cos(angle), s = Math.sin(angle);
  f.mx = x + (mount.localX * c - mount.localY * s);
  f.my = y + (mount.localX * s + mount.localY * c);
}
