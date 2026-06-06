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
const th = (id: string, x: number, y: number, health: number, maxHealth = 100): MountTargetView => ({
  id, x, y, vx: 0, vy: 0, health, maxHealth,
});
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

  it('filters candidates beyond maxDistance', () => {
    // 'near' is at d=50, 'far' is at d=600. With maxDistance=500, only
    // 'near' is in view.
    const targets = [t('far', 600, 0), t('near', 50, 0)];
    expect(pickTarget(0, 0, targets, null, all(), { maxDistance: 500 })?.id).toBe('near');
    // With no max, the nearest is still 'near' anyway.
    expect(pickTarget(0, 0, targets, null, all())?.id).toBe('near');
  });

  it('drops a sticky pin when the target drifts past maxDistance', () => {
    // Previous target 'prev' has drifted out to d=600; current candidate
    // 'alt' sits comfortably at d=200. With max=500, 'prev' is out and we
    // pick 'alt'.
    const targets = [t('prev', 600, 0), t('alt', 200, 0)];
    expect(pickTarget(0, 0, targets, 'prev', all(), { maxDistance: 500 })?.id).toBe('alt');
  });

  it('returns null when every candidate is out of maxDistance', () => {
    const targets = [t('a', 600, 0), t('b', 700, 0)];
    expect(pickTarget(0, 0, targets, null, all(), { maxDistance: 500 })).toBeNull();
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

  // ── Part C: smarter selection (health weight / commitment / dwell) ──

  it('healthWeight prefers a wounded target over a slightly closer full-HP one', () => {
    // full-HP target at d=100; wounded (10%) target at d=110. Pure-nearest
    // would pick the closer full-HP one; with healthWeight the wounded wins.
    const targets = [th('full', 100, 0, 100), th('wounded', 110, 0, 10)];
    expect(pickTarget(0, 0, targets, null, all())?.id).toBe('full'); // no weight → nearest
    expect(pickTarget(0, 0, targets, null, all(), { healthWeight: 1 })?.id).toBe('wounded');
  });

  it('healthWeight does NOT override a much-closer full-HP target', () => {
    // Wounded but far (d=500) vs full-HP point-blank (d=10): distance² still
    // dominates, so the close one wins even at full health.
    const targets = [th('far-wounded', 500, 0, 1), th('close-full', 10, 0, 100)];
    expect(pickTarget(0, 0, targets, null, all(), { healthWeight: 2 })?.id).toBe('close-full');
  });

  it('healthWeight 0 (default) is identical to pure nearest even with health present', () => {
    const targets = [th('a', 100, 0, 100), th('b', 90, 0, 5)];
    expect(pickTarget(0, 0, targets, null, all())?.id).toBe('b'); // b is closer
    expect(pickTarget(0, 0, targets, null, all(), { healthWeight: 0 })?.id).toBe('b');
  });

  it('switchMargin commits harder to the previous target (resists stealing)', () => {
    // alt is closer than prev, enough to beat the default 1.21 hysteresis but
    // not a 2.0 commitment margin.
    const targets = [t('prev', 100, 0), t('alt', 80, 0)];
    // default margin (1.21): 100² > 80²*1.21 (10000 > 7744) → switch to alt.
    expect(pickTarget(0, 0, targets, 'prev', all())?.id).toBe('alt');
    // margin 2.0: keep prev unless prevScore > bestScore*2 (10000 > 12800? no) → keep prev.
    expect(pickTarget(0, 0, targets, 'prev', all(), { switchMargin: 2 })?.id).toBe('prev');
  });

  it('dwellTicks holds the previous target until the delay elapses', () => {
    const targets = [t('prev', 200, 0), t('alt', 10, 0)]; // alt overwhelmingly closer
    // Within dwell → keep prev despite the far-better challenger.
    expect(
      pickTarget(0, 0, targets, 'prev', all(), { dwellTicks: 30, ticksSincePrevTarget: 5 })?.id,
    ).toBe('prev');
    // Dwell elapsed → switch to the better target.
    expect(
      pickTarget(0, 0, targets, 'prev', all(), { dwellTicks: 30, ticksSincePrevTarget: 30 })?.id,
    ).toBe('alt');
  });

  it('per-target `hostile` flag overrides the isHostile callback when defined', () => {
    // Single-viewer (client) path: the target carries its own hostility, so the
    // callback is ignored. `a` is flagged hostile, `b` not — even though the
    // callback would reject both.
    const targets: MountTargetView[] = [
      { id: 'a', x: 100, y: 0, vx: 0, vy: 0, hostile: true },
      { id: 'b', x: 50, y: 0, vx: 0, vy: 0, hostile: false },
    ];
    expect(pickTarget(0, 0, targets, null, () => false)?.id).toBe('a');
    // And a target whose flag is false is never chosen even if the callback says yes.
    expect(pickTarget(0, 0, targets, null, () => true)?.id).toBe('a');
  });

  it('falls back to the callback when a target has no `hostile` flag', () => {
    // Mixed: `c` has no flag (callback decides), `d` flagged false.
    const targets: MountTargetView[] = [
      { id: 'c', x: 100, y: 0, vx: 0, vy: 0 },
      { id: 'd', x: 50, y: 0, vx: 0, vy: 0, hostile: false },
    ];
    expect(pickTarget(0, 0, targets, null, (id) => id === 'c')?.id).toBe('c');
  });

  it('dwell does not resurrect a prev that left range / died', () => {
    // prev is out of range (gated out) → not held even within dwell.
    const targets = [t('prev', 5000, 0), t('alt', 100, 0)];
    expect(
      pickTarget(0, 0, targets, 'prev', all(), {
        maxDistance: 500, dwellTicks: 30, ticksSincePrevTarget: 1,
      })?.id,
    ).toBe('alt');
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
