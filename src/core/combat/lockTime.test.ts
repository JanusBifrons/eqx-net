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
    expect(s).toBeGreaterThan(LOCK_TUNING.baseSeconds * 0.9);
    expect(s).toBeLessThan(LOCK_TUNING.baseSeconds * 1.1);
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

/**
 * Heavy guns lock on ABSOLUTE distance (owner, 2026-11-10: "Lock time is based
 * on a formula which is speed, size and distance"; "It should take ages to
 * lock, that's by design"). Before this, distance entered only as a share of
 * the gun's own reach, so a 7× longer reach left edge-of-reach locks unchanged.
 */
describe('lockSeconds: absolute distance for heavy (M/L/XL) mounts', () => {
  const battleship = getShipKind('battleship');
  const destroyer = getShipKind('destroyer');
  const xl = WEAPON_LOCK_PROFILE.XL;
  /** A battleship's 16" on a still target `d` u away; `reach` = the gun's. */
  function heavy(d: number, signature: number, reach: number, absRange = xl.absRange): LockInputs {
    return {
      refSize: xl.refSize, tracking: xl.tracking, reach, sensor: sensorFor(battleship), pilotSpeed: 1,
      signature, dx: d, dy: 0, dvx: 0, dvy: 0, absRange,
    };
  }
  const REAL_REACH = 38_700; // 16" at real scale (u)
  const TODAY_REACH = 5_376; // 16" today (u)

  it('only M/L/XL profiles use absolute distance', () => {
    expect(WEAPON_LOCK_PROFILE.none.absRange).toBe(false);
    expect(WEAPON_LOCK_PROFILE.AA.absRange).toBe(false);
    expect(WEAPON_LOCK_PROFILE.S.absRange).toBe(false);
    expect(WEAPON_LOCK_PROFILE.M.absRange).toBe(true);
    expect(WEAPON_LOCK_PROFILE.L.absRange).toBe(true);
    expect(WEAPON_LOCK_PROFILE.XL.absRange).toBe(true);
  });

  it('is monotonic in absolute distance, whatever the reach', () => {
    let prev = 0;
    for (let d = 500; d <= 40_000; d += 500) {
      const s = lockSeconds(heavy(d, battleship.radius, REAL_REACH), LOCK_TUNING);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
    // Same distance, longer reach: same time (no reach share any more).
    const a = lockSeconds(heavy(3000, destroyer.radius, TODAY_REACH), LOCK_TUNING);
    const b = lockSeconds(heavy(3000, destroyer.radius, REAL_REACH), LOCK_TUNING);
    expect(b).toBeCloseTo(a, 6);
  });

  it('a 30 km shot takes clearly longer than a 3 km one, and "ages" (tens of seconds, not minutes)', () => {
    for (const target of [battleship, destroyer]) {
      const near = lockSeconds(heavy(3000, target.radius, REAL_REACH), LOCK_TUNING);
      const far = lockSeconds(heavy(30_000, target.radius, REAL_REACH), LOCK_TUNING);
      expect(far).toBeGreaterThan(near * 5);
      expect(far).toBeGreaterThan(LOCK_TUNING.maxSeconds); // past the old cap: no longer impossible
      expect(far).toBeGreaterThan(10);
      expect(far).toBeLessThan(60);
    }
  });

  it("today's 3–5k u capital engagements lock within ±20 % of the reach-share term", () => {
    for (const target of [battleship, destroyer]) {
      for (const d of [3000, 4000, 5000]) {
        const before = lockSeconds(heavy(d, target.radius, TODAY_REACH, false), LOCK_TUNING);
        const after = lockSeconds(heavy(d, target.radius, TODAY_REACH), LOCK_TUNING);
        expect(Number.isFinite(before)).toBe(true);
        expect(after / before).toBeGreaterThan(0.8);
        expect(after / before).toBeLessThan(1.2);
      }
    }
  });

  it('S mounts and fighter guns are unchanged (reach share, 8 s cap)', () => {
    const s = WEAPON_LOCK_PROFILE.S;
    const sub = { refSize: s.refSize, tracking: s.tracking, reach: 2295, sensor: 1, pilotSpeed: 1, signature: 120, dx: 2000, dy: 0, dvx: 0, dvy: 0 };
    // Reference: the pre-change formula written out.
    const want = (LOCK_TUNING.baseSeconds * 1 * 1 * (1 + LOCK_TUNING.rangeFactor * (2000 / 2295))) / 1;
    expect(lockSeconds({ ...sub, absRange: s.absRange }, LOCK_TUNING)).toBeCloseTo(want, 9);
    const fighterGun = inputs({ dx: 900 });
    expect(lockSeconds({ ...fighterGun, absRange: WEAPON_LOCK_PROFILE.none.absRange }, LOCK_TUNING))
      .toBeCloseTo(lockSeconds(fighterGun, LOCK_TUNING), 12);
  });

  it('distance never makes a heavy lock impossible; size/speed still can', () => {
    // A 16" at 35 km on a battleship: ~22 s, not Infinity.
    expect(Number.isFinite(lockSeconds(heavy(35_000, battleship.radius, REAL_REACH), LOCK_TUNING))).toBe(true);
    // Out of reach stays Infinity.
    expect(lockSeconds(heavy(50_000, battleship.radius, REAL_REACH), LOCK_TUNING)).toBe(Infinity);
    // A fast crossing fighter is still beyond the 16" (the gate is unchanged).
    const fighter = getShipKind('fighter');
    expect(lockSeconds({ ...heavy(1500, fighter.radius, REAL_REACH), dvy: 400 }, LOCK_TUNING)).toBe(Infinity);
  });

  it('structures (clampAtMax): the size/speed part caps at maxSeconds, then distance stretches heavy guns', () => {
    const fighter = getShipKind('fighter');
    const st = { ...LOCK_TUNING, clampAtMax: true };
    const crossing = { ...heavy(1500, fighter.radius, REAL_REACH), dvy: 400 };
    // Near: capped at maxSeconds × (abs ÷ reach-share) — about the old 8 s.
    const near = lockSeconds(crossing, st);
    expect(near).toBeGreaterThan(LOCK_TUNING.maxSeconds * 0.8);
    expect(near).toBeLessThan(LOCK_TUNING.maxSeconds * 1.2);
    // Far: longer than the old 8 s clamp.
    const far = lockSeconds({ ...heavy(30_000, fighter.radius, REAL_REACH), dvy: 400 }, st);
    expect(far).toBeGreaterThan(LOCK_TUNING.maxSeconds * 3);
    // A sub-capital structure gun keeps the plain 8 s clamp.
    const s = WEAPON_LOCK_PROFILE.S;
    const sMount = { ...crossing, refSize: s.refSize, tracking: 0.01, reach: 2295, absRange: s.absRange };
    expect(lockSeconds(sMount, st)).toBe(LOCK_TUNING.maxSeconds);
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
