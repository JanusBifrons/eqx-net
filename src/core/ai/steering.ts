/**
 * Pure steering primitives for AI movement (roaming-formation system, Phase 5).
 *
 * The drone movement model (`HostileDroneBehaviour`) is: pick a desired
 * HEADING, turn toward it, and thrust forward along the current facing. Per-kind
 * `linearDamping` (R2.25) provides the actual deceleration, so an "arrive"
 * behaviour only needs to ramp the forward-thrust SCALE down as the target
 * nears — damping then brakes the residual speed to a stop. That is the "they
 * should slow down and come to a stop… not float sideways/past" feel the user
 * asked for in the Phase-5 roaming-AI complaint.
 *
 * Zone-pure (src/core): scalar in / caller-owned out (allocation-free,
 * invariant #14), deterministic. Game-space is Y-up.
 */

export interface SteerOutput {
  /** Unit desired-heading direction toward the target (0,0 when already there). */
  dirX: number;
  dirY: number;
  /** Forward-thrust scale in [0, 1]. `seek` is always 1; `arrive` ramps it down
   *  inside `slowRadius` so the body eases in and damping brings it to a stop. */
  thrustScale: number;
  /** Distance to the target (callers gate fire / formation tightness on it). */
  dist: number;
}

/** Reusable scratch so callers in the per-tick hot loop allocate nothing. */
export function makeSteerOutput(): SteerOutput {
  return { dirX: 0, dirY: 0, thrustScale: 0, dist: 0 };
}

/** Seek: steer straight at the target at full thrust. */
export function seek(
  selfX: number,
  selfY: number,
  targetX: number,
  targetY: number,
  out: SteerOutput,
): SteerOutput {
  const dx = targetX - selfX;
  const dy = targetY - selfY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) {
    out.dirX = 0;
    out.dirY = 0;
    out.thrustScale = 0;
    out.dist = 0;
    return out;
  }
  out.dirX = dx / dist;
  out.dirY = dy / dist;
  out.thrustScale = 1;
  out.dist = dist;
  return out;
}

/**
 * Arrive: steer at the target but ramp the thrust scale linearly from 1 at
 * `slowRadius` down to 0 at the target, so the body decelerates (via damping)
 * and settles instead of overshooting. A `slowRadius <= 0` degenerates to a
 * pure seek with a hard stop at the target.
 */
export function arrive(
  selfX: number,
  selfY: number,
  targetX: number,
  targetY: number,
  slowRadius: number,
  out: SteerOutput,
): SteerOutput {
  const dx = targetX - selfX;
  const dy = targetY - selfY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) {
    out.dirX = 0;
    out.dirY = 0;
    out.thrustScale = 0;
    out.dist = 0;
    return out;
  }
  out.dirX = dx / dist;
  out.dirY = dy / dist;
  out.thrustScale = dist >= slowRadius ? 1 : (slowRadius > 1e-6 ? dist / slowRadius : 0);
  out.dist = dist;
  return out;
}
