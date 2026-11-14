/**
 * Test helpers for brains that fly through the virtual pilot (intent.input
 * bits). Reads the control keys back out of an intent, and steps a simple
 * kinematic model of `applyShipInput` for tests that integrate many ticks
 * without a Rapier world. Used only by tests.
 */
import {
  AI_INPUT_BOOST,
  AI_INPUT_REVERSE,
  AI_INPUT_THRUST,
  AI_INPUT_TURN_LEFT,
  AI_INPUT_TURN_RIGHT,
  type AiIntent,
} from '../contracts/IAiBehaviour.js';
import type { ShipKind } from '../../shared-types/shipKinds.js';
import { massOf, NPC_MASS_FALLBACK, shipAngularInertia } from '../../shared-types/shipScale/tuning.js';

/** +1 turn left (counter-clockwise, angle grows), -1 right, 0 none. */
export function turnOf(intent: AiIntent): number {
  const b = intent.input ?? 0;
  return ((b & AI_INPUT_TURN_LEFT) !== 0 ? 1 : 0) - ((b & AI_INPUT_TURN_RIGHT) !== 0 ? 1 : 0);
}

/** +1 thrust, -1 reverse, 0 neither. */
export function throttleOf(intent: AiIntent): number {
  const b = intent.input ?? 0;
  return ((b & AI_INPUT_THRUST) !== 0 ? 1 : 0) - ((b & AI_INPUT_REVERSE) !== 0 ? 1 : 0);
}

export function boostOf(intent: AiIntent): boolean {
  return ((intent.input ?? 0) & AI_INPUT_BOOST) !== 0;
}

export interface KinematicBody { x: number; y: number; vx: number; vy: number; angle: number; angvel: number }

/**
 * One 1/60 s step of `applyShipInput` + Rapier damping/integration for a body
 * of `kind` with an NPC's spawn mass. Approximate (no collisions, explicit
 * Euler), close enough to check where a brain flies.
 */
export function stepKinematic(b: KinematicBody, kind: ShipKind, intent: AiIntent): void {
  const dt = 1 / 60;
  const mass = massOf(kind, NPC_MASS_FALLBACK);
  const fx = -Math.sin(b.angle), fy = Math.cos(b.angle);
  const thr = throttleOf(intent);
  const throttle = thr > 0 ? 1 : thr < 0 ? -kind.reverseFactor : 0;
  let dv = (kind.thrustImpulse / mass) * throttle;
  if (boostOf(intent)) dv += (kind.thrustImpulse / mass) * (kind.boostMultiplier - 1);
  b.vx += fx * dv;
  b.vy += fy * dv;
  const turn = turnOf(intent);
  const torque = kind.turnTorque ?? 0;
  if (torque > 0) {
    b.angvel += (turn * torque) / shipAngularInertia(mass, kind.radius);
    b.angvel = Math.max(-kind.maxAngvel, Math.min(kind.maxAngvel, b.angvel));
  } else {
    b.angvel = turn * kind.maxAngvel;
  }
  const along = b.vx * fx + b.vy * fy;
  const latX = b.vx - along * fx, latY = b.vy - along * fy;
  b.vx -= latX * kind.lateralGrip;
  b.vy -= latY * kind.lateralGrip;
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > kind.maxSpeed) { b.vx *= kind.maxSpeed / sp; b.vy *= kind.maxSpeed / sp; }
  const ld = 1 / (1 + kind.linearDamping * dt);
  b.vx *= ld;
  b.vy *= ld;
  b.angvel /= 1 + kind.angularDamping * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.angle += b.angvel * dt;
}
