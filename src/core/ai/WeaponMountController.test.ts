import { describe, it, expect } from 'vitest';
import {
  pickTarget,
  rotateMountToward,
  clampToArc,
  wrapPi,
  STICKY_HYSTERESIS_FACTOR,
  type MountTargetView,
  type MountConfig,
} from './WeaponMountController.js';

const t = (id: string, x: number, y: number): MountTargetView => ({ id, x, y, vx: 0, vy: 0 });
const all = (): ((id: string) => boolean) => () => true;
const none = (): ((id: string) => boolean) => () => false;

describe('WeaponMountController.pickTarget', () => {
  it('returns null when the candidate list is empty', () => {
    expect(pickTarget(0, 0, [], null, all())).toBeNull();
  });

  it('returns null when no candidate passes the hostility filter', () => {
    const targets = [t('a', 10, 0), t('b', 20, 0)];
    expect(pickTarget(0, 0, targets, null, none())).toBeNull();
  });

  it('returns the only hostile target when one exists', () => {
    const targets = [t('a', 10, 0)];
    expect(pickTarget(0, 0, targets, null, all())?.id).toBe('a');
  });

  it('returns the nearest hostile when many are in view (no previous target)', () => {
    const targets = [t('far', 200, 0), t('close', 50, 0), t('mid', 120, 0)];
    expect(pickTarget(0, 0, targets, null, all())?.id).toBe('close');
  });

  it('skips non-hostile candidates even when they are closer', () => {
    const targets = [t('friendly', 10, 0), t('enemy', 50, 0)];
    const isHostile = (id: string): boolean => id === 'enemy';
    expect(pickTarget(0, 0, targets, null, isHostile)?.id).toBe('enemy');
  });

  it('sticks to the previously-picked target when no alternative is meaningfully closer', () => {
    // prev at d=100; a tied candidate at d=95. With factor 1.1 the threshold
    // is 95*1.1 = 104.5, and 100 <= 104.5, so prev wins (sticky).
    const targets = [t('prev', 100, 0), t('alt', 95, 0)];
    expect(pickTarget(0, 0, targets, 'prev', all())?.id).toBe('prev');
  });

  it('switches to a meaningfully closer hostile', () => {
    // prev at d=100; alternative at d=50. 100 > 50*1.1 = 55, so we switch.
    const targets = [t('prev', 100, 0), t('alt', 50, 0)];
    expect(pickTarget(0, 0, targets, 'prev', all())?.id).toBe('alt');
  });

  it('drops the sticky preference when the previous target left the candidate list', () => {
    // 'prev' is not in the targets array — assume it died or transited out.
    const targets = [t('a', 100, 0), t('b', 200, 0)];
    expect(pickTarget(0, 0, targets, 'prev', all())?.id).toBe('a');
  });

  it('drops the sticky preference when the previous target is no longer hostile', () => {
    // 'prev' is in the list but the filter no longer marks it hostile (e.g.
    // a drone whose hostility window expired).
    const targets = [t('prev', 50, 0), t('a', 80, 0)];
    const isHostile = (id: string): boolean => id !== 'prev';
    expect(pickTarget(0, 0, targets, 'prev', isHostile)?.id).toBe('a');
  });

  it('uses the supplied hysteresis factor when overridden', () => {
    // prev at d=100, alt at d=99. With factor 1.5 the threshold is 99*1.5
    // = 148.5; 100 <= 148.5 so prev wins (heavy sticky).
    const targets = [t('prev', 100, 0), t('alt', 99, 0)];
    expect(
      pickTarget(0, 0, targets, 'prev', all(), { stickyHysteresisFactor: 1.5 })?.id,
    ).toBe('prev');
    // Same scenario with factor 1.0 (no hysteresis): alt is closer, so it wins.
    expect(
      pickTarget(0, 0, targets, 'prev', all(), { stickyHysteresisFactor: 1.0 })?.id,
    ).toBe('alt');
  });

  it('STICKY_HYSTERESIS_FACTOR is a sane positive number > 1', () => {
    expect(STICKY_HYSTERESIS_FACTOR).toBeGreaterThan(1);
    expect(STICKY_HYSTERESIS_FACTOR).toBeLessThan(2);
  });

  it('breaks exact-distance ties deterministically by iteration order', () => {
    // Two targets at exactly d=100. The one that appears first wins because
    // the `<` comparison rejects ties — server and client iterate the same
    // ordered list, so the same target is picked on both sides.
    const ordered = [t('first', 100, 0), t('second', -100, 0)];
    expect(pickTarget(0, 0, ordered, null, all())?.id).toBe('first');
    const reversed = [t('second', -100, 0), t('first', 100, 0)];
    expect(pickTarget(0, 0, reversed, null, all())?.id).toBe('second');
  });
});

describe('WeaponMountController.rotateMountToward', () => {
  /** Standard test mount: ±30° arc, 4 rad/s. */
  const wing: MountConfig = {
    localX: 0,
    localY: 0,
    baseAngle: 0,
    arcMin: -Math.PI / 6,
    arcMax: Math.PI / 6,
    rotationSpeed: 4,
  };

  const dtSec = 1 / 60;

  it('returns 0 for a fixed mount (rotationSpeed=0)', () => {
    const fixed: MountConfig = { ...wing, rotationSpeed: 0 };
    expect(rotateMountToward(0.3, 1.0, fixed, dtSec)).toBe(0);
  });

  it('returns 0 for a zero-arc mount (arcMin === arcMax)', () => {
    const zeroArc: MountConfig = { ...wing, arcMin: 0, arcMax: 0 };
    expect(rotateMountToward(0, 1.0, zeroArc, dtSec)).toBe(0);
  });

  it('slews by at most rotationSpeed * dtSec per call', () => {
    // Desired bearing well past max-step. Per call we should advance by
    // exactly `4 * 1/60 ≈ 0.0667` rad.
    const after = rotateMountToward(0, Math.PI / 6, wing, dtSec);
    expect(after).toBeCloseTo(4 / 60, 6);
  });

  it('reaches the desired bearing in one step when the delta is small', () => {
    const after = rotateMountToward(0, 0.02, wing, dtSec);
    expect(after).toBeCloseTo(0.02, 6);
  });

  it('clamps the target into the mount arc', () => {
    // Asking for bearing past arcMax (π/6 ≈ 0.524) should clamp to arcMax,
    // and the slew should arrive there over time. After one tick we should
    // be advancing toward arcMax, not past it.
    const after = rotateMountToward(Math.PI / 6, Math.PI / 2, wing, dtSec);
    expect(after).toBeCloseTo(Math.PI / 6, 6);
  });

  it('slews toward arcMin when target is below arcMin', () => {
    // Currently at +0.1, asking for bearing -1.0 (past arcMin). Per tick
    // travels 4/60 ≈ 0.0667 in the negative direction.
    const after = rotateMountToward(0.1, -1.0, wing, dtSec);
    expect(after).toBeLessThan(0.1);
    expect(after).toBeGreaterThanOrEqual(-Math.PI / 6);
  });

  it('takes the short path around the wrap', () => {
    // Mount with full 360° arc — slewing should pick the closer rotation
    // direction (sign of wrapPi(delta)).
    const turret: MountConfig = { ...wing, arcMin: -Math.PI, arcMax: Math.PI };
    // Current angle near +π, target near -π — the short path is to wrap.
    const after = rotateMountToward(Math.PI - 0.05, -Math.PI + 0.05, turret, dtSec);
    // We should move IN the direction of the wrap (away from current, not
    // through 0). Specifically: the wrapPi(target - current) is +0.1, so
    // we move +max-step rad. Result lies past +π (which gets clamped) OR
    // is +π - 0.05 + 0.0667 = wrapped to roughly -π + 0.0167. Either way
    // the magnitude difference is bounded by max-step.
    const stepSize = 4 / 60;
    const deltaToTarget = Math.abs(wrapPi(after - (-Math.PI + 0.05)));
    expect(deltaToTarget).toBeLessThan(stepSize + 0.01);
  });
});

describe('WeaponMountController.clampToArc / wrapPi', () => {
  it('clampToArc enforces arc bounds', () => {
    const m: MountConfig = {
      localX: 0, localY: 0, baseAngle: 0,
      arcMin: -1, arcMax: 1, rotationSpeed: 2,
    };
    expect(clampToArc(-2, m)).toBe(-1);
    expect(clampToArc(0, m)).toBe(0);
    expect(clampToArc(2, m)).toBe(1);
  });

  it('wrapPi wraps angles into [-π, π]', () => {
    expect(wrapPi(0)).toBe(0);
    expect(wrapPi(Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapPi(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 9);
    expect(wrapPi(-Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1, 9);
    expect(wrapPi(4 * Math.PI)).toBeCloseTo(0, 6);
  });
});
