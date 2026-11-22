import { describe, expect, it } from 'vitest';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { shipBodyMass, shipTuning } from '../../../shared-types/shipScale/tuning.js';
import type { AiEntity } from '../../contracts/IAiBehaviour.js';
import { HullAvoid } from '../hullAvoid.js';
import { facingOf, makePilotHandling } from '../virtualPilot.js';
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
