import { describe, expect, it } from 'vitest';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { shipBodyMass, shipTuning } from '../../../shared-types/shipScale/tuning.js';
import type { AiEntity } from '../../contracts/IAiBehaviour.js';
import { HullAvoid } from '../hullAvoid.js';
import { AI_INPUT_REVERSE, AI_INPUT_THRUST } from '../../contracts/IAiBehaviour.js';
import { DEFAULT_PILOT_PARAMS, facingOf, makePilotHandling, makePilotState, pilotInputs } from '../virtualPilot.js';
import { MoveToHelm } from './moveTo.js';

const KIND = getShipKind('fighter');
const T = shipTuning(KIND);

function helm(): MoveToHelm {
  return new MoveToHelm(KIND, makePilotHandling(KIND, shipBodyMass(KIND)), T.shieldPad, new HullAvoid());
}

/** A fighter at rest at the origin, nose along +y (angle 0: forward is (-sin, cos)). */
const SELF: AiEntity = { id: 'f1', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

describe('MoveToHelm short move facing', () => {
  it('an owner move 150 u off to the side turns to face the point', () => {
    const m = helm();
    m.steerTo(SELF, 150, 0, 100, false, 0, false);
    expect(m.facing).toBeCloseTo(facingOf(1, 0), 6);
  });

  it('an owner move 150 u behind turns round to face the point', () => {
    const m = helm();
    m.steerTo(SELF, 0, -150, 100, false, 0, false);
    expect(m.facing).toBeCloseTo(facingOf(0, -1), 6);
  });

  it('inside the arrival radius an owner move keeps the nose', () => {
    const m = helm();
    const d = T.wingmanArrive * 0.9;
    m.steerTo({ ...SELF, vx: 0, vy: -40 }, 0, -d, 100, false, 0, false);
    expect(m.facing).toBe(SELF.angle);
  });

  it('a flock-follow fly-to 150 u away keeps the nose (flock spacing)', () => {
    expect(T.flockFollow).toBeGreaterThan(150);
    const m = helm();
    m.steerTo(SELF, 150, 0, -1, false, 0, false);
    expect(m.facing).toBe(SELF.angle);
  });
});

/**
 * 30 s of a ship parked off its guard spot at rest, flown through the real
 * virtual pilot with the pilot's own thrust model (v <- (v + a) / (1 + d dt)).
 * `thrustMul` scales the real push against the pilot's model (a speed
 * upgrade): the pilot must still settle. Returns thrust presses (off -> on).
 */
function parked(id: string, off: number, deg: number, thrustMul: number): { presses: number; end: number; max: number } {
  const kind = getShipKind(id);
  const h = makePilotHandling(kind, shipBodyMass(kind));
  const m = new MoveToHelm(kind, h, shipTuning(kind).shieldPad, new HullAvoid());
  const st = makePilotState();
  const r = (deg * Math.PI) / 180;
  // The spot is the origin, `deg` off the nose (angle 0, forward +y).
  let x = -Math.sin(r) * off, y = -Math.cos(r) * off, vx = 0, vy = 0, presses = 0, was = false, max = 0;
  for (let i = 0; i < 30 * 60; i++) {
    m.steerTo({ id: 's', x, y, vx, vy, angle: 0, angvel: 0 }, 0, 0, -1, false, 0, false);
    const bits = pilotInputs(h, st, DEFAULT_PILOT_PARAMS, 0, 0, vx, vy, m.facing, m.wvx, m.wvy, false);
    const on = (bits & AI_INPUT_THRUST) !== 0;
    if (on && !was) presses++;
    was = on;
    const a = thrustMul * ((on ? h.thrustAccel : 0) - ((bits & AI_INPUT_REVERSE) !== 0 ? h.reverseAccel : 0));
    vy = (vy + a) / (1 + h.linearDamping / 60);
    vx /= 1 + h.linearDamping / 60;
    x += vx / 60; y += vy / 60;
    max = Math.max(max, Math.hypot(x, y));
  }
  return { presses, end: Math.hypot(x, y), max };
}

describe('MoveToHelm parked at its spot settles (no thrust flicker)', () => {
  for (const id of ['fighter', 'heavy', 'destroyer', 'battleship', 'barge']) {
    for (const off of [10, 30]) {
      it(`${id} ${off} u off its spot: at most 2 thrust presses in 30 s, never drifts away`, () => {
        for (const deg of [0, 30, 60, 90, 150]) {
          for (const mul of [1, 1.5]) {
            const r = parked(id, off, deg, mul);
            expect(r.presses, `${deg} deg, x${mul}`).toBeLessThanOrEqual(2);
            expect(r.max, `${deg} deg, x${mul}`).toBeLessThanOrEqual(off + 0.5);
            expect(r.end).toBeLessThanOrEqual(off);
          }
        }
      });
    }
  }
});
