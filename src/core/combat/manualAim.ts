/**
 * Manual aim (exp/hud-mobile-first) — the shared rule for "the pilot is
 * pointing the guns". ONE owner for both sides of the wire (invariant #15):
 * the client's predicted turret slew (`localMountAim.tickLocalMountAngles`)
 * and the server's authoritative one (`WeaponMountTicker.tickPlayer`) both
 * call `manualAimMountBearing`, and the wire encoding is `encodeAim` /
 * `decodeAim` on both ends.
 *
 * Aim is a WORLD BEARING (radians, ship-angle convention: 0 = +y world,
 * `atan2(-dx, dy)`), not a point — the guns fire parallel along it. While a
 * pilot aims, each rotating mount slews toward the aim bearing (clamped to
 * its arc by `rotateMountToward`) instead of the auto-picked target.
 * Fixed mounts can't slew; for those the CLIENT turns the hull toward the
 * aim (ordinary turn bits — nothing new crosses the wire for that).
 */
import { wrapPi } from '../ai/WeaponMountController.js';

/** Wire quantisation: 4096 steps per turn (~0.088° — far below any arc). */
export const AIM_STEPS = 4096;
const TWO_PI = Math.PI * 2;

/** World bearing (any range) → wire integer in [0, AIM_STEPS). */
export function encodeAim(bearing: number): number {
  const turns = bearing / TWO_PI;
  const frac = turns - Math.floor(turns);
  const q = Math.round(frac * AIM_STEPS);
  return q >= AIM_STEPS ? 0 : q;
}

/** Wire integer → world bearing in (-π, π]. */
export function decodeAim(q: number): number {
  return wrapPi((q / AIM_STEPS) * TWO_PI);
}

/** Desired arc-local mount bearing for a manual aim — the value handed to
 *  `rotateMountToward` (which clamps it to the mount's arc). */
export function manualAimMountBearing(aimWorldBearing: number, shipAngle: number, mountBaseAngle: number): number {
  return wrapPi(aimWorldBearing - shipAngle - mountBaseAngle);
}

/** True when every mount is fixed (arc 0 / no slew) — the hull must turn to aim. */
export function allMountsFixed(mounts: ReadonlyArray<{ rotationSpeed: number; arcMin: number; arcMax: number }>): boolean {
  for (let i = 0; i < mounts.length; i++) {
    const m = mounts[i]!;
    if (m.rotationSpeed > 0 && m.arcMax > m.arcMin) return false;
  }
  return true;
}

/** Screen-space stick (x right, y DOWN, pointer convention) → world bearing.
 *  The camera draws game +y UP (pixi y = -gameY) and never rotates, so the
 *  game-space direction is (x, -y). */
export function stickToWorldBearing(x: number, yDown: number): number {
  return Math.atan2(-x, -yDown);
}

/** World vector (dx, dy in game space) → world bearing. */
export function vectorToWorldBearing(dx: number, dy: number): number {
  return Math.atan2(-dx, dy);
}
