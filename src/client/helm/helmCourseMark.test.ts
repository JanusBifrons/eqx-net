/**
 * Helm move marker (owner, 2026-11-12): "It says tap and it sets a course,
 * yet no visible indicator of where and what was tapped? A simple RTS style
 * move icon (green) would be very good. Not visible if the ship isn't
 * piloted or selected (or is not allied/owned)."
 *
 * The client decides, from its own helm order, whether the marker shows and
 * where: only for the local pilot's own capital while an order is active,
 * never while spectating. The renderer just draws `mirror.helmCourse`.
 */
import { describe, expect, it } from 'vitest';
import type { HelmOrder } from '@core/helm/helm';
import { makeHelmCourseMark, resolveHelmCourseMark } from './helmCourseMark.js';

function order(active: boolean, tx = 1200, ty = -3400): HelmOrder {
  return { active, tx, ty, speed: 3 };
}

describe('resolveHelmCourseMark', () => {
  it('shows the course point for the pilot of a capital with an active order', () => {
    const out = makeHelmCourseMark();
    expect(resolveHelmCourseMark(order(true), true, false, 7, out)).toBe(true);
    expect(out).toEqual({ x: 1200, y: -3400, seq: 7 });
  });

  it('is hidden with no order (arrived, WASD override, cleared)', () => {
    expect(resolveHelmCourseMark(order(false), true, false, 7, makeHelmCourseMark())).toBe(false);
  });

  it('is hidden when the ship flown takes no helm orders (not a capital / no ship)', () => {
    expect(resolveHelmCourseMark(order(true), false, false, 7, makeHelmCourseMark())).toBe(false);
  });

  it('is hidden while spectating', () => {
    expect(resolveHelmCourseMark(order(true), true, true, 7, makeHelmCourseMark())).toBe(false);
  });

  it('writes into the caller-owned record (no allocation)', () => {
    const out = makeHelmCourseMark();
    resolveHelmCourseMark(order(true, 5, 6), true, false, 1, out);
    const same = out;
    resolveHelmCourseMark(order(true, 8, 9), true, false, 2, out);
    expect(out).toBe(same);
    expect(out).toEqual({ x: 8, y: 9, seq: 2 });
  });
});
