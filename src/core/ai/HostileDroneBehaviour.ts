import {
  type AiEntity,
  type AiIntent,
  type AiWorldView,
  type IAiBehaviour,
  nearestPlayer,
} from '../contracts/IAiBehaviour.js';
import { HITSCAN_RANGE, WEAPON_COOLDOWN_TICKS } from '../combat/Weapons.js';

/** Steering impulse magnitude per tick, tuned so a drone reaches ~50 u/s before drag balance. */
const DRONE_THRUST = 0.5;
/** Yaw P-gain applied to the bearing error (radians). */
const DRONE_TURN_KP = 4.0;
/** Maximum torque magnitude, in Rapier angular-impulse units. */
const DRONE_MAX_TORQUE = 0.4;
/** Drone fires when within this range. */
const DRONE_FIRE_RANGE = HITSCAN_RANGE * 0.6;
/** Aim cone (radians). Drones won't fire unless their nose is within this many radians of the target. */
const DRONE_AIM_TOLERANCE = 0.25; // ~14°

/**
 * Hostile drone: steers toward nearest player and fires hitscan when in range
 * and roughly aimed. Cooldown matches the player weapon (10 ticks @ 60 Hz).
 *
 * Per-instance state holds only the last fire tick — no allocations on the hot
 * path. The forward-vector convention matches `World.applyInput`: nose points
 * `(-sin θ, cos θ)` at angle θ.
 */
export class HostileDroneBehaviour implements IAiBehaviour {
  private lastFireTick = -1_000_000;

  tick(self: AiEntity, view: AiWorldView): AiIntent {
    const target = nearestPlayer(view, self.x, self.y);
    if (target === null) {
      return { fx: 0, fy: 0, torque: 0 };
    }

    const dx = target.x - self.x;
    const dy = target.y - self.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-3) {
      return { fx: 0, fy: 0, torque: 0 };
    }

    // Bearing to target. The forward vector at angle θ is (-sin θ, cos θ),
    // so the angle whose forward points at (dx, dy) is atan2(-dx, dy).
    const desiredAngle = Math.atan2(-dx, dy);
    let bearingError = desiredAngle - self.angle;
    // Wrap to [-π, π].
    while (bearingError > Math.PI) bearingError -= 2 * Math.PI;
    while (bearingError < -Math.PI) bearingError += 2 * Math.PI;

    // Damped P-controller: torque toward bearing, minus current angvel for damping.
    let torque = DRONE_TURN_KP * bearingError - 1.5 * self.angvel;
    if (torque > DRONE_MAX_TORQUE) torque = DRONE_MAX_TORQUE;
    else if (torque < -DRONE_MAX_TORQUE) torque = -DRONE_MAX_TORQUE;

    // Forward thrust along the drone's current facing.
    const fwdX = -Math.sin(self.angle);
    const fwdY = Math.cos(self.angle);
    const fx = fwdX * DRONE_THRUST;
    const fy = fwdY * DRONE_THRUST;

    // Fire when in range, roughly aimed, and off cooldown.
    let fire: { dirX: number; dirY: number } | undefined;
    const aimed = Math.abs(bearingError) <= DRONE_AIM_TOLERANCE;
    const inRange = dist <= DRONE_FIRE_RANGE;
    const offCooldown = view.tick - this.lastFireTick >= WEAPON_COOLDOWN_TICKS;
    if (aimed && inRange && offCooldown) {
      fire = { dirX: fwdX, dirY: fwdY };
      this.lastFireTick = view.tick;
    }

    return fire ? { fx, fy, torque, fire } : { fx, fy, torque };
  }
}
