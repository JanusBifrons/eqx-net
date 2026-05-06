import {
  type AiEntity,
  type AiIntent,
  type AiWorldView,
  type IAiBehaviour,
  nearestPlayer,
} from '../contracts/IAiBehaviour.js';
import { HITSCAN_RANGE, WEAPON_COOLDOWN_TICKS } from '../combat/Weapons.js';
import { getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';

/** Drone fires when within this fraction of full hitscan range. */
const DRONE_FIRE_RANGE = HITSCAN_RANGE * 0.6;
/** Aim cone (radians). Drones won't fire unless their nose is within this many radians of the target. */
const DRONE_AIM_TOLERANCE = 0.25; // ~14°
/** Damping coefficient on the P-controller's angvel term. Tuned so the drone
 *  doesn't oscillate around its bearing — independent of ship kind. */
const ANGVEL_DAMPING = 1.5;

/**
 * Hostile drone: steers toward nearest player and fires hitscan when in range
 * and roughly aimed. Cooldown matches the player weapon (10 ticks @ 60 Hz).
 *
 * Per-kind tuning (`thrust`, `turnKp`, `maxTorque`) is read from the
 * `ShipKind.ai` block of the kind the drone spawned with — each drone in a
 * sector can be a different kind and steer with that kind's character. The
 * forward-vector convention matches `World.applyInput`: nose points
 * `(-sin θ, cos θ)` at angle θ.
 */
export class HostileDroneBehaviour implements IAiBehaviour {
  private lastFireTick = -1_000_000;
  private readonly kind: ShipKind;

  constructor(kind?: ShipKind | string) {
    // Accept the kind as either a `ShipKind` record or a kind id (string), so
    // tests that don't care about kind tuning can still construct with no
    // arg (`new HostileDroneBehaviour()` falls back to the catalogue default).
    this.kind = typeof kind === 'object' && kind !== null
      ? kind
      : getShipKind(typeof kind === 'string' ? kind : null);
  }

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
    const maxTorque = this.kind.ai.maxTorque;
    let torque = this.kind.ai.turnKp * bearingError - ANGVEL_DAMPING * self.angvel;
    if (torque > maxTorque) torque = maxTorque;
    else if (torque < -maxTorque) torque = -maxTorque;

    // Forward thrust along the drone's current facing.
    const fwdX = -Math.sin(self.angle);
    const fwdY = Math.cos(self.angle);
    const fx = fwdX * this.kind.ai.thrust;
    const fy = fwdY * this.kind.ai.thrust;

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
