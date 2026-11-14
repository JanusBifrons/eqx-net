/**
 * Which of its group's locks a turret aims at (fire control, capitals). A
 * capital weapon group can hold several locks; its turrets share them out
 * instead of all training on the first: turret `ordinal` (its place in the
 * group's mount list) prefers lock `ordinal % n`, and when that one is out of
 * its reach or arc it takes the next lock round the list it CAN engage. With
 * none engageable it parks on the first lock. One lock (every non-capital
 * group) is always index 0, so those groups aim exactly as before.
 *
 * Gun size first (owner 2026-11-14): among the locks it can engage, a turret
 * takes the class its size prefers (`mountPriority`: heavy guns capitals and
 * structures, AA small craft), the round-robin above deciding only among
 * equal-priority locks. The class comes from the lock's hit shape
 * (`kindId`: a ship kind, else a structure), which both sides already fill
 * identically, so no second input can disagree (#15).
 *
 * Reach is the shared turret range gate (`mountInReach`): from the mount to
 * the nearest point of the target's hit shape (`shapes[i]`), the same rule
 * `mountCanEngage` applies to NPC and structure turrets.
 *
 * Used by the server's turret aim + fire gate (`LockSubsystem.aimKeyFor`) and
 * the client's predicted aim + ghost gate (`ColyseusClient.fcMountAimKey`), so
 * both sides pick the same target (invariants #12, #15). Pure,
 * allocation-free.
 */
import { inMountArc, type FireControlMount } from './mountFireControl.js';
import { mountInReach, type MountRangeTarget } from './mountReach.js';
import { mountPriority, targetClassOfKind } from './mountTargeting.js';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';

/** Half-width (rad) a fixed gun (arcMin === arcMax) counts as covering. */
const FIXED_GUN_HALF_ARC = 0.3;

function canEngage(
  m: FireControlMount, frameAngle: number, dx: number, dy: number, reach: number, shape: MountRangeTarget | undefined,
): boolean {
  if (!mountInReach(dx, dy, reach, shape)) return false;
  if (m.arcMax - m.arcMin < 1e-6) {
    let rel = Math.atan2(-dx, dy) - frameAngle - m.baseAngle - m.arcMin;
    rel -= Math.round(rel / (2 * Math.PI)) * 2 * Math.PI;
    return Math.abs(rel) <= FIXED_GUN_HALF_ARC;
  }
  return inMountArc(m, frameAngle, dx, dy);
}

/**
 * Index (0..n-1) of the lock turret `ordinal` aims at. `mx`/`my` is the
 * mount's world origin, `frameAngle` the hull heading, `tx`/`ty` the world
 * positions of the group's `n` LOCKED targets in lock order, `shapes` their
 * hit shapes (absent = measured to the centre, and no class preference).
 */
export function pickTurretLock(
  m: FireControlMount & { readonly size?: WeaponMount['size'] },
  frameAngle: number,
  mx: number,
  my: number,
  reach: number,
  ordinal: number,
  n: number,
  tx: ArrayLike<number>,
  ty: ArrayLike<number>,
  shapes?: ArrayLike<MountRangeTarget>,
): number {
  if (n <= 1) return 0;
  const start = ordinal % n;
  let best = -1;
  let bestPri = Infinity;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    // Class first (cheap, cached per kind): skip a lock no better than the best.
    const pri = shapes === undefined ? 0 : mountPriority(m.size, targetClassOfKind(shapes[i]!.kindId));
    if (pri >= bestPri) continue;
    if (!canEngage(m, frameAngle, tx[i]! - mx, ty[i]! - my, reach, shapes?.[i])) continue;
    best = i;
    bestPri = pri;
    if (pri === 0) break;
  }
  return best < 0 ? 0 : best;
}
