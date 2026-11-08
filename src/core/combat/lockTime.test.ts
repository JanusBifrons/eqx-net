import { describe, it, expect } from 'vitest';
import { angularRate, lockSeconds, type LockInputs } from './lockTime.js';
import { newLock, stepLock } from './lockState.js';
import { LOCK_TUNING, WEAPON_LOCK_PROFILE, lockCapacityFor, sensorFor, signatureFor } from '../../shared-types/combat/lockProfile.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

function inputs(over: Partial<LockInputs>): LockInputs {
  return {
    refSize: 40, tracking: 2.5, reach: 1000, sensor: 1, pilotSpeed: 1,
    signature: 40, dx: 300, dy: 0, dvx: 0, dvy: 0,
    ...over,
  };
}

describe('lockSeconds', () => {
  it('a matched weapon vs a still target locks in about baseSeconds', () => {
    const s = lockSeconds(inputs({ dx: 1 }), LOCK_TUNING);
    expect(s).toBeGreaterThan(0.9);
    expect(s).toBeLessThan(1.1);
  });

  it('out of reach cannot lock', () => {
    expect(lockSeconds(inputs({ dx: 5000 }), LOCK_TUNING)).toBe(Infinity);
  });

  it('further, faster-crossing and smaller targets all take longer', () => {
    const near = lockSeconds(inputs({ dx: 100 }), LOCK_TUNING);
    const far = lockSeconds(inputs({ dx: 900 }), LOCK_TUNING);
    expect(far).toBeGreaterThan(near);
    const crossing = lockSeconds(inputs({ dvy: 600 }), LOCK_TUNING);
    expect(crossing).toBeGreaterThan(lockSeconds(inputs({}), LOCK_TUNING));
    const tiny = lockSeconds(inputs({ refSize: 400, signature: 20 }), LOCK_TUNING);
    expect(tiny).toBeGreaterThan(lockSeconds(inputs({ refSize: 400, signature: 400 }), LOCK_TUNING));
  });

  it('better sensors / pilot lock faster', () => {
    const base = lockSeconds(inputs({}), LOCK_TUNING);
    expect(lockSeconds(inputs({ pilotSpeed: 2 }), LOCK_TUNING)).toBeCloseTo(base / 2, 5);
  });

  it('a capital main gun can NOT lock a fast fighter, its AA can', () => {
    const battleship = getShipKind('battleship');
    const fighter = getShipKind('fighter');
    const crossing = { dx: 1500, dy: 0, dvx: 0, dvy: 400 }; // fighter darting across at 1.5k
    const xl = WEAPON_LOCK_PROFILE.XL;
    const aa = WEAPON_LOCK_PROFILE.AA;
    const common = { reach: 6000, sensor: sensorFor(battleship), pilotSpeed: 1, signature: signatureFor(fighter), ...crossing };
    expect(lockSeconds({ ...common, refSize: xl.refSize, tracking: xl.tracking }, LOCK_TUNING)).toBe(Infinity);
    expect(lockSeconds({ ...common, refSize: aa.refSize, tracking: aa.tracking }, LOCK_TUNING)).toBeLessThan(LOCK_TUNING.maxSeconds);
  });

  it('angular rate is the crossing speed over range', () => {
    expect(angularRate(100, 0, 0, 50)).toBeCloseTo(0.5, 6);
    expect(angularRate(100, 0, 50, 0)).toBe(0); // head-on
  });
});

describe('lock capacity', () => {
  it('defaults: 1 for sub-capitals, 3 for capitals; slot + pilot override', () => {
    expect(lockCapacityFor(getShipKind('fighter'), undefined)).toBe(1);
    expect(lockCapacityFor(getShipKind('battleship'), undefined)).toBe(3);
    expect(lockCapacityFor(getShipKind('fighter'), { lockCapacity: 2 })).toBe(2);
    expect(lockCapacityFor(getShipKind('fighter'), undefined, { lockSpeed: 1, extraLocks: 1 })).toBe(2);
  });
});

describe('stepLock', () => {
  it('hostile target: acquires then locks', () => {
    const e = newLock('s:1', true);
    expect(e.stage).toBe('acquiring');
    expect(stepLock(e, 0.5, 1, 2, 1.5)).toBe('none');
    expect(stepLock(e, 0.6, 1, 2, 1.5)).toBe('locked');
    expect(e.stage).toBe('locked');
  });

  it('neutral target: failsafe first, COMMIT when it finishes, then acquire', () => {
    const e = newLock('s:2', false);
    expect(e.stage).toBe('failsafe');
    expect(stepLock(e, 1.9, 1, 2, 1.5)).toBe('none');
    expect(stepLock(e, 0.2, 1, 2, 1.5)).toBe('commit');
    expect(e.stage).toBe('acquiring');
    expect(e.progress).toBe(0);
  });

  it('a lock that cannot progress drops after the grace window', () => {
    const e = newLock('s:3', true);
    expect(stepLock(e, 1.0, Infinity, 2, 1.5)).toBe('none');
    expect(stepLock(e, 0.6, Infinity, 2, 1.5)).toBe('dropped');
  });

  it('coming back into reach resets the grace timer', () => {
    const e = newLock('s:4', true);
    stepLock(e, 1.0, Infinity, 2, 1.5);
    stepLock(e, 0.1, 1, 2, 1.5);
    expect(e.lostFor).toBe(0);
    expect(stepLock(e, 1.0, Infinity, 2, 1.5)).toBe('none');
  });
});
