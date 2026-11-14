import { describe, it, expect } from 'vitest';
import { pickTurretLock } from './turretLockPick.js';

// A deck turret facing ahead (+y), ±135° training.
const FWD = { baseAngle: 0, arcMin: -2.36, arcMax: 2.36, rotationSpeed: 1 };
const REACH = 5000;
// Three locks: ahead, right, left.
const TX = [0, 1000, -1000];
const TY = [2000, 0, 0];

describe('pickTurretLock', () => {
  it('one lock: every turret takes it (non-capital groups unchanged)', () => {
    for (let o = 0; o < 5; o++) expect(pickTurretLock(FWD, 0, 0, 0, REACH, o, 1, TX, TY)).toBe(0);
  });

  it('three locks: turrets spread round the locks by their place in the group', () => {
    const picks = [0, 1, 2, 3, 4].map((o) => pickTurretLock(FWD, 0, 0, 0, REACH, o, 3, TX, TY));
    expect(picks).toEqual([0, 1, 2, 0, 1]);
  });

  it('a turret that cannot engage its own share takes the next lock it can', () => {
    // Lock 1 is out of reach: turret 1 moves on to lock 2.
    const tx = [0, 99_000, -1000];
    const ty = [2000, 0, 0];
    expect(pickTurretLock(FWD, 0, 0, 0, REACH, 1, 3, tx, ty)).toBe(2);
    // Lock 2 is behind this turret (outside its arc): turret 2 wraps to lock 0.
    const tx2 = [0, 1000, 0];
    const ty2 = [2000, 0, -2000];
    expect(pickTurretLock(FWD, 0, 0, 0, REACH, 2, 3, tx2, ty2)).toBe(0);
  });

  it('nothing engageable: park on the first lock', () => {
    const tx = [0, 0];
    const ty = [-2000, -3000];
    expect(pickTurretLock(FWD, 0, 0, 0, REACH, 1, 2, tx, ty)).toBe(0);
  });

  it('fixed guns count a narrow window either side of the nose', () => {
    const fixed = { baseAngle: 0, arcMin: 0, arcMax: 0, rotationSpeed: 0 };
    // Lock 1 sits 90° off the nose; the gun keeps lock 0 (dead ahead).
    expect(pickTurretLock(fixed, 0, 0, 0, REACH, 1, 2, [0, 1000], [2000, 0])).toBe(0);
  });

  it('reach is measured to the target hull (shared mountInReach), not its centre', () => {
    // Lock 1: a battleship bow-on, centre reach + 2,000 u ahead, bow well inside reach.
    const tx = [0, 0];
    const ty = [-2000, REACH + 2000];
    const hull = [{ radius: 0 }, { kindId: 'battleship', angle: Math.PI, shieldUp: false }];
    expect(pickTurretLock(FWD, 0, 0, 0, REACH, 1, 2, tx, ty)).toBe(0); // centre: out of reach, parks
    expect(pickTurretLock(FWD, 0, 0, 0, REACH, 1, 2, tx, ty, hull)).toBe(1);
    // Broadside on at the same centre: the hull is out of reach too.
    const side = [{ radius: 0 }, { kindId: 'battleship', angle: Math.PI / 2, shieldUp: false }];
    expect(pickTurretLock(FWD, 0, 0, 0, REACH, 1, 2, tx, ty, side)).toBe(0);
  });

  describe('gun size prefers the class it can hurt (owner 2026-11-14, mountPriority)', () => {
    // Locks: a fighter ahead, a heavy cruiser to starboard, a structure to port.
    const tx = [0, 1500, -1500];
    const ty = [2000, 0, 0];
    const shapes = [
      { kindId: 'fighter', angle: 0, shieldUp: false, radius: 0 },
      { kindId: 'heavy-cruiser', angle: 0, shieldUp: false, radius: 0 },
      { kindId: null, angle: 0, shieldUp: false, radius: 60 },
    ];
    it('heavy turrets share the capital and the structure, never the fighter', () => {
      const xl = { ...FWD, size: 'XL' as const };
      const picks = [0, 1, 2, 3, 4].map((o) => pickTurretLock(xl, 0, 0, 0, REACH, o, 3, tx, ty, shapes));
      expect(picks).not.toContain(0);
      // The turret-index spread holds among the equal-priority locks.
      expect(new Set(picks)).toEqual(new Set([1, 2]));
    });
    it('AA turrets all take the fighter', () => {
      const aa = { ...FWD, size: 'AA' as const };
      for (let o = 0; o < 5; o++) expect(pickTurretLock(aa, 0, 0, 0, REACH, o, 3, tx, ty, shapes)).toBe(0);
    });
    it('fallback: with only the fighter in reach, a heavy turret takes it', () => {
      const xl = { ...FWD, size: 'XL' as const };
      const far = [0, 50_000, -50_000];
      for (let o = 0; o < 5; o++) expect(pickTurretLock(xl, 0, 0, 0, REACH, o, 3, far, [2000, 0, 0], shapes)).toBe(0);
    });
  });
});
