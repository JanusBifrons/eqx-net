/**
 * Incoming-fire warning — the pure fall-point / danger math and the salvo
 * grouping (`incomingFire.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  countdownLabel,
  groupShellPasses,
  isShellDangerous,
  makeFallGroup,
  minScreenSizeMul,
  NOT_INCOMING,
  predictShellPass,
  shellDangerRadius,
  shellRemainingS,
  type ShellPass,
} from './incomingFire.js';
import { shipTuning } from '../../../shared-types/shipScale/tuning.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';

const pass = (): ShellPass => ({ t: 0, miss: 0, x: 0, y: 0 });

describe('predictShellPass', () => {
  it('a shell flying straight at a parked ship passes at miss 0, arriving at distance / speed', () => {
    // 16" shell 23 km out, 2300 u/s → 10 s.
    const p = predictShellPass(-23_000, 0, 2300, 0, 30, 0, 0, 0, 0, pass());
    expect(p.t).toBeCloseTo(10, 6);
    expect(p.miss).toBeCloseTo(0, 6);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it('a shell offset 500 u from the line passes 500 u away', () => {
    const p = predictShellPass(-10_000, 500, 2000, 0, 30, 0, 0, 0, 0, pass());
    expect(p.t).toBeCloseTo(5, 6);
    expect(p.miss).toBeCloseTo(500, 6);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(500, 6);
  });

  it('uses relative motion: a ship flying into the shell line meets it', () => {
    // Shell along y = 0 eastward; ship 1000 u north, flying south at 200 u/s.
    // At t = 5 the shell is at x = 0 and the ship at y = 0.
    const p = predictShellPass(-10_000, 0, 2000, 0, 30, 0, 1000, 0, -200, pass());
    expect(p.t).toBeCloseTo(4.95, 1);
    expect(p.miss).toBeLessThan(60);
  });

  it('a shell that runs out of flight first is clipped to its end point', () => {
    // 10 s to reach the ship but only 4 s of flight left → ends 8 km short.
    const p = predictShellPass(-20_000, 0, 2000, 0, 4, 0, 0, 0, 0, pass());
    expect(p.t).toBe(4);
    expect(p.x).toBeCloseTo(-12_000, 6);
    expect(p.miss).toBeCloseTo(12_000, 6);
  });

  it('a shell moving away (already past) is not incoming', () => {
    const p = predictShellPass(1000, 0, 2000, 0, 30, 0, 0, 0, 0, pass());
    expect(p.miss).toBe(NOT_INCOMING);
  });
});

describe('shellRemainingS', () => {
  it('lifetime minus the time flown since first seen', () => {
    // maxTicks 1800 = 30 s; flown 2300 u at 2300 u/s = 1 s.
    expect(shellRemainingS(1800, 2300, 2300)).toBeCloseTo(29, 6);
    expect(shellRemainingS(60, 99_999, 2300)).toBe(0);
    expect(shellRemainingS(60, 0, 0)).toBe(0);
  });
});

describe('danger radius', () => {
  it('comes from the ship\'s tuning (#18) and grows with the hull', () => {
    const fighter = shipTuning(getShipKind('fighter'));
    const bb = shipTuning(getShipKind('battleship'));
    const fk = getShipKind('fighter');
    expect(fighter.incomingFireRadius).toBeCloseTo(2 * (fk.radius + fighter.shieldPad), 6);
    expect(bb.incomingFireRadius).toBeGreaterThan(fighter.incomingFireRadius * 20);
  });

  it('adds the gun\'s splash and flags a pass inside it', () => {
    const R = shellDangerRadius(88, 160);
    expect(R).toBe(248);
    const near = predictShellPass(-10_000, 200, 2000, 0, 30, 0, 0, 0, 0, pass());
    const far = predictShellPass(-10_000, 3000, 2000, 0, 30, 0, 0, 0, 0, pass());
    expect(isShellDangerous(near, R)).toBe(true);
    expect(isShellDangerous(far, R)).toBe(false);
    expect(isShellDangerous(far, shellDangerRadius(88, 0))).toBe(false);
  });
});

describe('groupShellPasses', () => {
  function run(points: Array<[number, number, number]>, joinDist = 200, joinDt = 2) {
    const n = points.length;
    const fx = new Float64Array(n), fy = new Float64Array(n), sx = new Float64Array(n), sy = new Float64Array(n);
    const t = new Float64Array(n), r = new Float64Array(n);
    points.forEach(([x, y, tt], i) => { fx[i] = x; fy[i] = y; sx[i] = x - 20_000; sy[i] = y; t[i] = tt; r[i] = 88; });
    const groups = [makeFallGroup(), makeFallGroup(), makeFallGroup()];
    const count = groupShellPasses(fx, fy, sx, sy, t, r, n, joinDist, joinDt, groups);
    return { count, groups };
  }

  it('a 3-gun salvo landing together makes one marker with the soonest countdown', () => {
    const { count, groups } = run([[0, 0, 10.2], [40, -30, 10.0], [-50, 20, 10.4]]);
    expect(count).toBe(1);
    expect(groups[0]!.count).toBe(3);
    expect(groups[0]!.t).toBeCloseTo(10.0, 6);
    expect(groups[0]!.x).toBeCloseTo(-10 / 3, 6);
  });

  it('a second salvo 8 s later, or in a different place, gets its own marker', () => {
    expect(run([[0, 0, 10], [10, 0, 18]]).count).toBe(2);
    expect(run([[0, 0, 10], [5_000, 0, 10]]).count).toBe(2);
  });

  it('never writes past the pool', () => {
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < 6; i++) pts.push([i * 10_000, 0, 5]);
    expect(run(pts).count).toBe(3);
  });
});

describe('minScreenSizeMul', () => {
  it('scales a 24 u shell at a battleship\'s zoom-out floor up to the minimum, never down', () => {
    const s = 0.15 / 4.8; // gameplay floor ÷ battleship hull zoom factor
    const mul = minScreenSizeMul(24, s, 3);
    expect(24 * s * mul).toBeCloseTo(3, 6);
    expect(minScreenSizeMul(24, 1, 3)).toBe(1);
  });
});

describe('countdownLabel', () => {
  it('rounds up to tenths and is cached (same string object)', () => {
    expect(countdownLabel(3.21)).toBe('3.3s');
    expect(countdownLabel(0)).toBe('0.0s');
    expect(countdownLabel(3.25)).toBe(countdownLabel(3.3));
    expect(countdownLabel(500)).toBe('99.9s');
  });
});
