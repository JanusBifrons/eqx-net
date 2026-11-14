import { describe, it, expect } from 'vitest';
import { intentToControlBits, makeControlIntent, headingOf, wrapPi } from './intentToControlBits.js';
import { makeWingmanControls, reverseAccelFor, type WingmanShipStats } from './types.js';

const STATS: WingmanShipStats = {
  maxSpeed: 250, linearDamping: 0.3, maxAngvel: 2, angularDamping: 0, reverseAccel: 30,
};

/** Pose facing `angle`, moving along the nose at `vFwd`. */
function pose(angle: number, vFwd = 0, angvel = 0) {
  return { x: 0, y: 0, vx: -Math.sin(angle) * vFwd, vy: Math.cos(angle) * vFwd, angle, angvel };
}

function run(dvx: number, dvy: number, p: ReturnType<typeof pose>, stats = STATS, boost = false) {
  const intent = makeControlIntent();
  intent.dvx = dvx; intent.dvy = dvy; intent.boost = boost;
  return intentToControlBits(intent, p, stats, makeWingmanControls());
}

describe('intentToControlBits', () => {
  it('heading convention: the nose of angle 0 points +Y, positive angle turns left', () => {
    expect(headingOf(0, 1)).toBeCloseTo(0);
    expect(headingOf(-1, 0)).toBeCloseTo(Math.PI / 2); // nose (-sin, cos) at +90° = -X
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI);
  });

  it('turns toward the desired heading with the right sign', () => {
    // Facing +Y, want to go -X (heading +π/2): turn left.
    const left = run(-100, 0, pose(0));
    expect(left.turnLeft).toBe(true);
    expect(left.turnRight).toBe(false);
    // Want +X (heading −π/2): turn right.
    const right = run(100, 0, pose(0));
    expect(right.turnRight).toBe(true);
    expect(right.turnLeft).toBe(false);
  });

  it('does not turn when already on heading (no chatter)', () => {
    const c = run(0, 100, pose(0.005));
    expect(c.turnLeft || c.turnRight).toBe(false);
    expect(c.thrust).toBe(true);
  });

  it('never thrusts while facing away from the desired heading', () => {
    for (const a of [Math.PI / 2, 2, Math.PI, -2.5, -Math.PI / 2]) {
      const c = run(0, 200, pose(a));
      expect(c.thrust, `angle ${a}`).toBe(false);
      expect(c.boost).toBe(false);
    }
  });

  it('brakes (reverse) when facing away while still moving forward', () => {
    // Facing -Y, moving -Y at 150, want +Y.
    const c = run(0, 200, pose(Math.PI, 150));
    expect(c.reverse).toBe(true);
    expect(c.thrust).toBe(false);
  });

  it('brakes near the target: faster than the desired speed ⇒ reverse, never thrust+reverse together', () => {
    const c = run(0, 20, pose(0, 120));
    expect(c.reverse).toBe(true);
    expect(c.thrust).toBe(false);
  });

  it('desired zero velocity ⇒ brake against the forward motion without turning', () => {
    const fwd = run(0, 0, pose(0.7, 80));
    expect(fwd.reverse).toBe(true);
    expect(fwd.turnLeft || fwd.turnRight || fwd.thrust).toBe(false);
    const back = run(0, 0, pose(0.7, -80));
    expect(back.thrust).toBe(true);
    const still = run(0, 0, pose(0.7, 0));
    expect(still).toEqual(makeWingmanControls());
  });

  it('boosts only when asked, aligned and thrusting', () => {
    expect(run(0, 250, pose(0), STATS, true).boost).toBe(true);
    expect(run(0, 250, pose(0), STATS, false).boost).toBe(false);
    expect(run(0, 250, pose(0.3), STATS, true).boost).toBe(false); // outside the boost cone
    expect(run(0, 250, pose(0, 250), STATS, true).boost).toBe(false); // at speed: no thrust
  });

  it('torque-turned hull stops pushing once its coast covers the remaining turn', () => {
    const cap: WingmanShipStats = { ...STATS, turnTorque: 5, angularDamping: 1 };
    // 0.2 rad to go, turning toward it at 0.3 rad/s ⇒ coast 0.3 rad ≥ error.
    expect(run(-Math.sin(0.2) * 100, Math.cos(0.2) * 100, pose(0, 0, 0.3), cap).turnLeft).toBe(false);
    // Not yet turning ⇒ push.
    expect(run(-Math.sin(0.2) * 100, Math.cos(0.2) * 100, pose(0, 0, 0), cap).turnLeft).toBe(true);
  });

  it('reverseAccelFor matches applyShipInput (impulse·reverseFactor per 1/60 s tick over mass)', () => {
    expect(reverseAccelFor({ thrustImpulse: 2, reverseFactor: 0.5 }, 2)).toBeCloseTo(30);
    expect(reverseAccelFor({ thrustImpulse: 2, reverseFactor: 0.5 }, 0)).toBe(0);
  });
});
