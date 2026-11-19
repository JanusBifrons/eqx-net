/**
 * Seconds for a capital turret at (mx, my) to lock structure `t` (signature
 * `sig`): the shared `lockSeconds` with the mount's size profile, its gun's
 * reach and the hull's sensor, capped by the testMode `capS`. Infinity = can't.
 * Writes into the caller's reused `inp` (#14). Used by
 * `WeaponMountTicker.tickCapitalMounts`.
 */
import type { MountTargetView } from '../../core/ai/WeaponMountController.js';
import { capLockSeconds, lockSeconds, type LockInputs } from '../../core/combat/lockTime.js';
import type { WeaponMount } from '../../shared-types/shipKinds.js';
import { LOCK_TUNING, WEAPON_LOCK_PROFILE, type MountSize } from '../../shared-types/combat/lockProfile.js';

export function structureLockSecs(
  inp: LockInputs, mount: WeaponMount, reach: number, sensor: number, sig: number, t: MountTargetView,
  mx: number, my: number, selfVx: number, selfVy: number, capS: number | undefined,
): number {
  const p = WEAPON_LOCK_PROFILE[(mount.size ?? 'none') as MountSize | 'none'];
  inp.refSize = p.refSize;
  inp.tracking = p.tracking;
  inp.absRange = p.absRange;
  inp.reach = reach;
  inp.sensor = sensor;
  inp.signature = sig;
  inp.dx = t.x - mx;
  inp.dy = t.y - my;
  inp.dvx = t.vx - selfVx;
  inp.dvy = t.vy - selfVy;
  return capLockSeconds(lockSeconds(inp, LOCK_TUNING), inp, capS);
}
