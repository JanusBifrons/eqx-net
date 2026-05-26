import type RAPIER from '@dimforge/rapier2d-compat';
import type { ShipKind } from '../../shared-types/shipKinds.js';

/**
 * Pure per-tick player input → physics transformation.
 *
 * Drifty-arcade model with four stages — see the original comment in
 * `World.applyInput` for the design rationale. This module owns the
 * math; `World.applyInput` is now a thin wrapper that looks up
 * `(body, kind)` and forwards.
 *
 *   1. Throttle — forward + reverse impulse, boost multiplier when
 *      throttle > 0 and boost held.
 *   2. Snappy turn — direct setAngvel on hold, releases let angular
 *      damping decay naturally.
 *   3. Lateral-grip — 1-pole low-pass on the sideways component of
 *      linvel. Stable for grip ∈ [0, 1] at fixed 60 Hz.
 *   4. Max-speed clamp.
 *
 * Stages 1, 3, 4 run every tick regardless of input (so a coasting
 * body still bleeds lateral velocity + respects the speed cap). Stage
 * 2 runs only on input so angvel can decay naturally on release.
 *
 * No allocation in the hot path — every value is a primitive.
 */

export interface ShipInputArgs {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost?: boolean;
  reverse?: boolean;
}

export function applyShipInput(
  body: RAPIER.RigidBody,
  kind: ShipKind,
  input: ShipInputArgs,
): void {
  // Forward direction at the body's current facing. The visual "nose" is
  // local -Y in Pixi (see `buildShipGfx`), which maps to (-sin θ, cos θ)
  // in Rapier (Y-up).
  const angle = body.rotation();
  const fx = -Math.sin(angle);
  const fy = Math.cos(angle);

  // ---- 1. Throttle (forward + reverse, cancellable) ----------------------
  const fwd = input.thrust ? 1 : 0;
  const rev = input.reverse ? kind.reverseFactor : 0;
  const throttle = fwd - rev;
  if (throttle !== 0) {
    const boostMul = input.boost && throttle > 0 ? kind.boostMultiplier : 1;
    const mag = kind.thrustImpulse * boostMul * throttle;
    body.applyImpulse({ x: fx * mag, y: fy * mag }, true);
  }

  // ---- 2. Snappy turn (direct setAngvel, snap-stop on release) ---------
  const target = (input.turnLeft ? 1 : 0) - (input.turnRight ? 1 : 0);
  body.setAngvel(target * kind.maxAngvel, true);

  // ---- 3. Lateral-grip filter (1-pole low-pass on sideways component) ---
  if (kind.lateralGrip > 0) {
    const v = body.linvel();
    const fwdComp = v.x * fx + v.y * fy;
    const latX = v.x - fwdComp * fx;
    const latY = v.y - fwdComp * fy;
    if (latX !== 0 || latY !== 0) {
      body.setLinvel(
        { x: v.x - latX * kind.lateralGrip, y: v.y - latY * kind.lateralGrip },
        true,
      );
    }
  }

  // ---- 4. Max-speed clamp ----------------------------------------------
  const v2 = body.linvel();
  const sp2 = v2.x * v2.x + v2.y * v2.y;
  const cap2 = kind.maxSpeed * kind.maxSpeed;
  if (sp2 > cap2) {
    const k = kind.maxSpeed / Math.sqrt(sp2);
    body.setLinvel({ x: v2.x * k, y: v2.y * k }, true);
  }
}
