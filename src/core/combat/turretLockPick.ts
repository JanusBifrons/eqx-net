/**
 * Which of its group's locks a turret aims at (fire control, capitals). A
 * capital weapon group can hold several locks; its turrets share them out
 * instead of all training on the first: turret `ordinal` (its place in the
 * group's mount list) prefers lock `ordinal % n`, and when that one is out of
 * its reach or arc it takes the next lock round the list it CAN engage. With
 * none engageable it parks on the first lock. One lock (every non-capital
 * group) is always index 0, so those groups aim exactly as before.
 *
 * Used by the server's turret aim + fire gate (`LockSubsystem.aimKeyFor`) and
 * the client's predicted aim + ghost gate (`ColyseusClient.fcMountAimKey`), so
 * both sides pick the same target (invariants #12, #15). Pure,
 * allocation-free.
 */
import { inMountArc, type FireControlMount } from './mountFireControl.js';

/** Half-width (rad) a fixed gun (arcMin === arcMax) counts as covering. */
const FIXED_GUN_HALF_ARC = 0.3;

function canEngage(m: FireControlMount, frameAngle: number, dx: number, dy: number, reach: number): boolean {
  if (dx * dx + dy * dy > reach * reach) return false;
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
 * positions of the group's `n` LOCKED targets in lock order.
 */
export function pickTurretLock(
  m: FireControlMount,
  frameAngle: number,
  mx: number,
  my: number,
  reach: number,
  ordinal: number,
  n: number,
  tx: ArrayLike<number>,
  ty: ArrayLike<number>,
): number {
  if (n <= 1) return 0;
  const start = ordinal % n;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (canEngage(m, frameAngle, tx[i]! - mx, ty[i]! - my, reach)) return i;
  }
  return 0;
}
