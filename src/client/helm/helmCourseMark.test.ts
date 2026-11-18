/**
 * Helm move marker (owner, 2026-11-12): "It says tap and it sets a course,
 * yet no visible indicator of where and what was tapped? A simple RTS style
 * move icon (green) would be very good. Not visible if the ship isn't
 * piloted or selected (or is not allied/owned)."
 *
 * The client decides, from its own helm order, whether the marker shows and
 * where: only for the local pilot's own ship while an order is active,
 * never while spectating. The renderer just draws `mirror.helmCourse`.
 */
import { describe, expect, it } from 'vitest';
import type { HelmOrder } from '@core/helm/helm';
import { makeHelmCourseMark, resolveHelmCourseMark } from './helmCourseMark.js';

function order(active: boolean, tx = 1200, ty = -3400): HelmOrder {
  return { active, tx, ty, speed: 3 };
}

describe('resolveHelmCourseMark', () => {
  it('shows the course point for the pilot with an active order', () => {
    const out = makeHelmCourseMark();
    expect(resolveHelmCourseMark(order(true), true, false, 7, out)).toBe(true);
    expect(out).toMatchObject({ x: 1200, y: -3400, seq: 7, routeN: 0 });
  });

  it('is hidden with no order (arrived, WASD override, cleared)', () => {
    expect(resolveHelmCourseMark(order(false), true, false, 7, makeHelmCourseMark())).toBe(false);
  });

  it('is hidden when the ship flown takes no helm orders (no ship)', () => {
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
    expect(out).toMatchObject({ x: 8, y: 9, seq: 2 });
  });

  it('carries the turns still ahead for the route line (navigation slice 14)', () => {
    const out = makeHelmCourseMark();
    const o: HelmOrder = { ...order(true, 30, 40), route: { pts: new Float64Array([10, 0, 20, 0, 30, 40]), n: 3, idx: 1 } };
    resolveHelmCourseMark(o, true, false, 1, out);
    expect(out.routeN).toBe(2);
    expect(Array.from(out.route.subarray(0, 4))).toEqual([20, 0, 30, 40]);
    const buf = out.route;
    o.route!.idx = 2;
    resolveHelmCourseMark(o, true, false, 1, out);
    expect(out.routeN).toBe(1);
    expect(out.route).toBe(buf); // reused
    resolveHelmCourseMark(order(true), true, false, 2, out);
    expect(out.routeN).toBe(0);
  });
});
