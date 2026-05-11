import { describe, it, expect } from 'vitest';
import {
  pickTarget,
  STICKY_HYSTERESIS_FACTOR,
  type MountTargetView,
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
