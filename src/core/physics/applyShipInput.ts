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
 *   1. Throttle — forward + reverse impulse (no boost multiplier).
 *   1b. Boost — an INDEPENDENT forward impulse along the ship's facing
 *      whenever boost is held, regardless of thrust/turn/reverse. It is
 *      no longer a throttle multiplier. The `boost` bit is energy-gated
 *      by the caller (server strips it when the pool can't afford a tick;
 *      the client mirrors that gate before predicting) so prediction and
 *      authority stay in lockstep.
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
 *
 * Phase 4 WS-B2 (per-instance stat upgrades): an optional `mul` carries the two
 * PHYSICS multipliers (`topSpeed`, `turnRate`) derived from the ship instance's
 * spent stat allocation (`deriveStatMultipliers` in `../leveling/shipStats.ts`).
 * This is the ONE seam where the movement clamps live, so applying the
 * multipliers HERE (and nowhere else) keeps the server sim and the client
 * prediction byte-identical (invariants #4 / #12 — risk #1). `topSpeed` scales
 * BOTH `thrustImpulse` (so the ship can actually reach the raised cap) and the
 * `maxSpeed` clamp; `turnRate` scales `maxAngvel`. Absent / undefined `mul` ⇒
 * factors of 1 ⇒ byte-identical to pre-WS-B2 (every legacy caller is unchanged).
 */

export interface ShipInputArgs {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost?: boolean;
  reverse?: boolean;
}

/** The PHYSICS subset of the per-instance stat multipliers that `applyShipInput`
 *  reads. A subset of `ShipStatMultipliers` (`../leveling/shipStats.ts`) — only
 *  the two factors that touch per-tick movement, so the seam stays minimal. */
export interface ShipInputMultipliers {
  /** Scales `thrustImpulse` + the `maxSpeed` clamp. */
  topSpeed: number;
  /** Scales `maxAngvel`. */
  turnRate: number;
}

export function applyShipInput(
  body: RAPIER.RigidBody,
  kind: ShipKind,
  input: ShipInputArgs,
  mul?: ShipInputMultipliers,
): void {
  // Per-instance physics multipliers (1 = no upgrade). Read ONCE here so the
  // server sim + client prediction scale movement identically.
  const speedMul = mul !== undefined && mul.topSpeed > 0 ? mul.topSpeed : 1;
  const turnMul = mul !== undefined && mul.turnRate > 0 ? mul.turnRate : 1;
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
    const mag = kind.thrustImpulse * speedMul * throttle;
    body.applyImpulse({ x: fx * mag, y: fy * mag }, true);
  }

  // ---- 1b. Boost (independent forward kick along facing) -----------------
  // Boost no longer modifies the movement direction or requires thrust: while
  // held it always pushes along the ship's nose, regardless of thrust/turn/
  // reverse. Magnitude thrustImpulse*(boostMultiplier-1) so that thrust+boost
  // keeps the old combined magnitude (thrustImpulse*boostMultiplier) and
  // boost-alone still delivers a strong forward push. The caller energy-gates
  // the `boost` bit (see header) so an exhausted pool can't keep boosting.
  if (input.boost) {
    const bmag = kind.thrustImpulse * speedMul * (kind.boostMultiplier - 1);
    if (bmag !== 0) body.applyImpulse({ x: fx * bmag, y: fy * bmag }, true);
  }

  // ---- 2. Snappy turn (direct setAngvel, snap-stop on release) ---------
  const target = (input.turnLeft ? 1 : 0) - (input.turnRight ? 1 : 0);
  body.setAngvel(target * kind.maxAngvel * turnMul, true);

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
  const cap = kind.maxSpeed * speedMul;
  const cap2 = cap * cap;
  if (sp2 > cap2) {
    const k = cap / Math.sqrt(sp2);
    body.setLinvel({ x: v2.x * k, y: v2.y * k }, true);
  }
}
