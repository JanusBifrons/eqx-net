import { describe, it, expect } from 'vitest';
import type RAPIER from '@dimforge/rapier2d-compat';
import { applyShipInput } from './applyShipInput.js';
import type { ShipKind } from '../../shared-types/shipKinds.js';

/**
 * Locks the facing-direction boost model (weapon-autofire-boost-mechanics):
 *
 *   - Boost is an INDEPENDENT forward impulse along the ship's facing,
 *     applied whenever boost is held — NO LONGER gated on thrust.
 *   - Magnitude = thrustImpulse * (boostMultiplier - 1), so thrust+boost
 *     keeps the OLD combined magnitude (thrustImpulse * boostMultiplier)
 *     and boost-alone still gives a strong forward push.
 *   - boostMultiplier === 1 ⇒ standalone boost is a no-op (guarded).
 *
 * Uses a lightweight mock RigidBody so the math is asserted exactly without a
 * Rapier world (fast, deterministic). Only the methods `applyShipInput` calls
 * are stubbed; velocity stays zero so the lateral-grip + speed-clamp stages are
 * inert and never apply their own `setLinvel`.
 */

interface MockBody {
  body: RAPIER.RigidBody;
  impulses: Array<{ x: number; y: number }>;
  angvel: number;
}

function makeBody(angle: number): MockBody {
  const impulses: Array<{ x: number; y: number }> = [];
  const state = { angvel: 0 };
  const zero = { x: 0, y: 0 };
  const body = {
    rotation: () => angle,
    applyImpulse: (v: { x: number; y: number }) => impulses.push({ x: v.x, y: v.y }),
    linvel: () => zero,
    setLinvel: () => {},
    setAngvel: (w: number) => { state.angvel = w; },
  } as unknown as RAPIER.RigidBody;
  return { body, impulses, get angvel() { return state.angvel; } } as MockBody;
}

/** Minimal ShipKind with only the fields `applyShipInput` reads. */
function makeKind(boostMultiplier: number): ShipKind {
  return {
    thrustImpulse: 10,
    boostMultiplier,
    reverseFactor: 0.5,
    maxAngvel: 3,
    lateralGrip: 0.1,
    maxSpeed: 1000,
  } as unknown as ShipKind;
}

function sum(impulses: Array<{ x: number; y: number }>): { x: number; y: number } {
  return impulses.reduce((a, b) => ({ x: a.x + b.x, y: a.y + b.y }), { x: 0, y: 0 });
}

// At angle 0 the forward vector is (-sin0, cos0) = (0, 1): forward is +Y.
const FWD = { x: 0, y: 1 };

describe('applyShipInput — facing-direction boost', () => {
  it('boost WITHOUT thrust pushes forward along facing', () => {
    const m = makeBody(0);
    applyShipInput(m.body, makeKind(2), { thrust: false, turnLeft: false, turnRight: false, boost: true });
    // Only the boost impulse: thrustImpulse * (2 - 1) = 10, along +Y.
    expect(m.impulses).toHaveLength(1);
    expect(m.impulses[0]!.x).toBeCloseTo(FWD.x * 10, 6);
    expect(m.impulses[0]!.y).toBeCloseTo(FWD.y * 10, 6);
  });

  it('thrust + boost preserves the OLD combined magnitude (thrustImpulse * boostMultiplier)', () => {
    const m = makeBody(0);
    applyShipInput(m.body, makeKind(2), { thrust: true, turnLeft: false, turnRight: false, boost: true });
    // throttle impulse (10) + boost impulse (10) = 20 = thrustImpulse * 2.
    const total = sum(m.impulses);
    expect(total.y).toBeCloseTo(20, 6);
    expect(total.x).toBeCloseTo(0, 6);
  });

  it('boost while REVERSING still nets a forward push (boost overrides movement input)', () => {
    const m = makeBody(0);
    applyShipInput(m.body, makeKind(2), { thrust: false, turnLeft: false, turnRight: false, boost: true, reverse: true });
    // reverse throttle = -reverseFactor*thrustImpulse = -5 (backward), boost = +10 (forward).
    const total = sum(m.impulses);
    expect(total.y).toBeCloseTo(5, 6); // net forward
    expect(total.y).toBeGreaterThan(0);
  });

  it('boostMultiplier === 1 makes standalone boost a no-op (guarded zero impulse)', () => {
    const m = makeBody(0);
    applyShipInput(m.body, makeKind(1), { thrust: false, turnLeft: false, turnRight: false, boost: true });
    expect(m.impulses).toHaveLength(0);
  });

  it('plain thrust (no boost) applies exactly thrustImpulse forward', () => {
    const m = makeBody(0);
    applyShipInput(m.body, makeKind(2), { thrust: true, turnLeft: false, turnRight: false, boost: false });
    expect(m.impulses).toHaveLength(1);
    expect(m.impulses[0]!.y).toBeCloseTo(10, 6);
  });

  it('boost direction follows the body facing (angle = π/2 ⇒ forward is -X)', () => {
    const m = makeBody(Math.PI / 2);
    applyShipInput(m.body, makeKind(2), { thrust: false, turnLeft: false, turnRight: false, boost: true });
    // forward = (-sin(π/2), cos(π/2)) = (-1, 0) ⇒ impulse (-10, 0).
    expect(m.impulses[0]!.x).toBeCloseTo(-10, 6);
    expect(m.impulses[0]!.y).toBeCloseTo(0, 6);
  });
});
