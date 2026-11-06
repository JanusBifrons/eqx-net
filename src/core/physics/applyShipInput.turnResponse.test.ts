import { describe, it, expect } from 'vitest';
import type RAPIER from '@dimforge/rapier2d-compat';
import { applyShipInput } from './applyShipInput.js';
import type { ShipKind } from '../../shared-types/shipKinds.js';

/**
 * Capital ships (R&D, plan eager-sauteeing-curry; docs/research/
 * ww2-surface-combatants.md): a big hull takes time to start and stop
 * turning. With `turnTorque` set, a held turn applies a torque impulse and
 * the physics (inertia + angular damping) does the rest; the rate is capped
 * at `maxAngvel`. Unset (every existing kind), the turn snaps as before.
 * The real-World response time is locked in capitalShips.test.ts.
 */
function makeBody(w0 = 0): { body: RAPIER.RigidBody; torques: number[]; get w(): number } {
  const s = { w: w0 };
  const torques: number[] = [];
  const zero = { x: 0, y: 0 };
  const body = {
    rotation: () => 0,
    applyImpulse: () => {},
    applyTorqueImpulse: (t: number) => { torques.push(t); },
    linvel: () => zero,
    setLinvel: () => {},
    angvel: () => s.w,
    setAngvel: (w: number) => { s.w = w; },
  } as unknown as RAPIER.RigidBody;
  return { body, torques, get w() { return s.w; } };
}
const kind = (turnTorque?: number): ShipKind => ({
  thrustImpulse: 1, boostMultiplier: 1, reverseFactor: 0, maxAngvel: 0.6, lateralGrip: 0, maxSpeed: 100,
  ...(turnTorque !== undefined ? { turnTorque } : {}),
} as unknown as ShipKind);
const left = { thrust: false, reverse: false, turnLeft: true, turnRight: false, boost: false };
const none = { ...left, turnLeft: false };

describe('applyShipInput — torque turning (capital ships)', () => {
  it('without turnTorque the turn snaps to maxAngvel (unchanged)', () => {
    const b = makeBody();
    applyShipInput(b.body, kind(), left);
    expect(b.w).toBeCloseTo(0.6, 9);
    expect(b.torques).toEqual([]);
  });

  it('with turnTorque a held turn applies the torque impulse and does not set the rate', () => {
    const b = makeBody();
    applyShipInput(b.body, kind(5), left);
    expect(b.torques).toEqual([5]);
    expect(b.w).toBe(0);
  });

  it('released, no torque is applied: the hull keeps turning and damping winds it down', () => {
    const b = makeBody(0.4);
    applyShipInput(b.body, kind(5), none);
    expect(b.torques).toEqual([]);
    expect(b.w).toBeCloseTo(0.4, 9);
  });

  it('the turn rate is capped at maxAngvel', () => {
    const b = makeBody(0.9);
    applyShipInput(b.body, kind(5), left);
    expect(b.w).toBeCloseTo(0.6, 9);
  });
});
