/**
 * Closed-form planar 2-bone IK for reaching arms (crane / loading arm).
 * Structure restyle §5 "targeted clip": a clip carries a world target and
 * this solves the arm so its tip reaches it.
 *
 * Pure maths: plain numbers in, a caller-owned scratch out. Deterministic
 * and allocation-free (invariant #14): one call writes only `out`.
 *
 * Conventions:
 * - World angles are radians in the physics convention: angle `a` points
 *   along `(cos a, sin a)` (the Rapier rotation of the local +x axis).
 * - `shoulder` is relative to `baseAngle`; `elbow` is relative to the upper
 *   bone. Both are wrapped into [-π, π] with the shared `wrapPi`.
 * - `bendSign` +1 bends the elbow counter-clockwise (positive `elbow`),
 *   -1 clockwise, so an arm always folds the same way.
 *
 * TODO(structure-restyle): a telescoping (slide) third DOF. Not trivial to
 * fold in closed form with limits; add when the crane design asks for it.
 */
import { wrapPi } from '../ai/WeaponMountController.js';

/** Per-joint limits, relative angles in radians. Must satisfy
 *  -π ≤ min ≤ max ≤ π; use `IK_NO_LIMITS` (±Infinity) for a free joint. */
export interface IkLimits {
  shoulderMin: number;
  shoulderMax: number;
  elbowMin: number;
  elbowMax: number;
}

export const IK_NO_LIMITS: Readonly<IkLimits> = Object.freeze({
  shoulderMin: -Infinity,
  shoulderMax: Infinity,
  elbowMin: -Infinity,
  elbowMax: Infinity,
});

/** Caller-owned scratch the solver writes into. */
export interface IkReachOut {
  /** Shoulder angle relative to `baseAngle`, [-π, π]. */
  shoulder: number;
  /** Elbow angle relative to the upper bone, [-π, π]. */
  elbow: number;
  /** True when the reported tip is on the target (within `IK_REACH_EPS`
   *  scaled by arm length). False when out of range or limit-clamped. */
  reached: boolean;
  /** Elbow joint world point. */
  elbowX: number;
  elbowY: number;
  /** Tip (end-effector) world point actually reached, i.e. FK of the
   *  reported angles. */
  endX: number;
  endY: number;
}

export function createIkReachOut(): IkReachOut {
  return { shoulder: 0, elbow: 0, reached: false, elbowX: 0, elbowY: 0, endX: 0, endY: 0 };
}

/** Relative tolerance for `reached` (multiplied by max(1, len1 + len2)). */
export const IK_REACH_EPS = 1e-6;

/** Below this the base→target direction is undefined; aim along `baseAngle`. */
const DIR_EPS = 1e-12;

/** Clamp a wrapped angle into [min, max]; when outside, snap to the limit
 *  that is angularly nearer (so a wrap across ±π picks the right side). */
function clampJoint(a: number, min: number, max: number): number {
  if (a >= min && a <= max) return a;
  const dMin = Math.abs(wrapPi(a - min));
  const dMax = Math.abs(wrapPi(a - max));
  return dMin <= dMax ? min : max;
}

/** Sanitise a bone length: negative / NaN / non-finite become 0. */
function boneLen(l: number): number {
  return l > 0 && Number.isFinite(l) ? l : 0;
}

/**
 * Forward kinematics: write the elbow and tip world points for the given
 * relative joint angles into `out` (only elbowX/Y and endX/Y are touched).
 */
export function twoBoneForward(
  baseX: number,
  baseY: number,
  baseAngle: number,
  len1: number,
  len2: number,
  shoulder: number,
  elbow: number,
  out: IkReachOut,
): void {
  const l1 = boneLen(len1);
  const l2 = boneLen(len2);
  const a1 = baseAngle + shoulder;
  const a2 = a1 + elbow;
  const ex = baseX + l1 * Math.cos(a1);
  const ey = baseY + l1 * Math.sin(a1);
  out.elbowX = ex;
  out.elbowY = ey;
  out.endX = ex + l2 * Math.cos(a2);
  out.endY = ey + l2 * Math.sin(a2);
}

/**
 * Solve a 2-bone planar arm rooted at (baseX, baseY), facing `baseAngle`,
 * to reach (targetX, targetY).
 *
 * - Reachable: exact law-of-cosines solution on the `bendSign` side.
 * - Too far: fully extended toward the target. Too close: folded to the
 *   minimum reach toward the target. Both report `reached = false`.
 * - Limits: the elbow is clamped first, the shoulder is then re-aimed for
 *   that elbow (closest tip to the target) and clamped. The reported tip
 *   is FK of the final angles.
 * - Target on the base: aims along `baseAngle`.
 * - Zero / invalid lengths are treated as 0 (no division by zero).
 */
export function solveTwoBoneReach(
  baseX: number,
  baseY: number,
  baseAngle: number,
  len1: number,
  len2: number,
  targetX: number,
  targetY: number,
  limits: Readonly<IkLimits>,
  bendSign: 1 | -1,
  out: IkReachOut,
): void {
  const l1 = boneLen(len1);
  const l2 = boneLen(len2);
  const dx = targetX - baseX;
  const dy = targetY - baseY;
  const d = Math.sqrt(dx * dx + dy * dy);
  const aimDir = d > DIR_EPS ? Math.atan2(dy, dx) : baseAngle;

  // Elbow from the law of cosines, distance clamped into the reachable
  // annulus [|l1 - l2|, l1 + l2] (cos clamp covers both ends at once).
  let elbow = 0;
  if (l1 > 0 && l2 > 0) {
    let c = (d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2);
    if (c > 1) c = 1;
    else if (c < -1) c = -1;
    elbow = (bendSign < 0 ? -1 : 1) * Math.acos(c);
  }
  elbow = clampJoint(wrapPi(elbow), limits.elbowMin, limits.elbowMax);

  // Shoulder: aim the elbow-fixed tip (l1 + l2·cos e, l2·sin e in the upper
  // bone's frame) at the target. Exact when reachable, closest otherwise.
  const tipX = l1 + l2 * Math.cos(elbow);
  const tipY = l2 * Math.sin(elbow);
  const tipOffset = tipX * tipX + tipY * tipY > DIR_EPS * DIR_EPS ? Math.atan2(tipY, tipX) : 0;
  const shoulder = clampJoint(
    wrapPi(aimDir - tipOffset - baseAngle),
    limits.shoulderMin,
    limits.shoulderMax,
  );

  out.shoulder = shoulder;
  out.elbow = elbow;
  twoBoneForward(baseX, baseY, baseAngle, l1, l2, shoulder, elbow, out);
  const mx = out.endX - targetX;
  const my = out.endY - targetY;
  const tol = IK_REACH_EPS * Math.max(1, l1 + l2);
  out.reached = mx * mx + my * my <= tol * tol;
}
