import { describe, it, expect } from 'vitest';
import { stepRoute, createNavRoute, setNavRoute, stepNavRoute, NAV_ROUTE_POINTS } from './stepRoute.js';
import { NAV_ROUTE_MAX_POINTS } from '../nav/routePlanner.js';

describe('stepRoute — the one patrol-route stepper (RTS Part B slice 11)', () => {
  // Three waypoints, packed x0, y0, x1, y1, x2, y2.
  const route = [0, 0, 1000, 0, 1000, 1000];

  it('keeps the waypoint while the ship is outside the arrive radius', () => {
    expect(stepRoute(route, 3, 1, 0, 0, 300)).toBe(1);
    expect(stepRoute(route, 3, 1, 1000, 301, 300)).toBe(1);
  });

  it('moves on to the next waypoint inside the arrive radius (the edge counts)', () => {
    expect(stepRoute(route, 3, 1, 1000, 300, 300)).toBe(2);
    expect(stepRoute(route, 3, 0, 10, -10, 300)).toBe(1);
  });

  it('loops last → first', () => {
    expect(stepRoute(route, 3, 2, 1000, 1000, 300)).toBe(0);
  });

  it('walks a ship that visits every waypoint round the loop in order', () => {
    let leg = 0;
    const seen: number[] = [];
    for (let lap = 0; lap < 2; lap++) {
      for (let k = 0; k < 3; k++) {
        const x = route[leg * 2]!;
        const y = route[leg * 2 + 1]!;
        seen.push(leg);
        leg = stepRoute(route, 3, leg, x, y, 50);
      }
    }
    expect(seen).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('reads only the first `count` waypoints of a larger buffer (typed arrays too)', () => {
    const buf = new Float64Array(8);
    buf.set([0, 0, 500, 0]);
    expect(stepRoute(buf, 2, 1, 500, 0, 10)).toBe(0);
  });

  it('an empty route stays at 0', () => {
    expect(stepRoute(route, 0, 0, 0, 0, 300)).toBe(0);
  });
});

describe('stepRoute open mode + NavRoute (navigation slice 6)', () => {
  const route = [0, 0, 1000, 0, 1000, 1000];

  it('an open route runs out instead of wrapping', () => {
    expect(stepRoute(route, 3, 2, 1000, 1000, 300, true)).toBe(3);
    expect(stepRoute(route, 3, 3, 0, 0, 300, true)).toBe(3); // finished stays finished
    expect(stepRoute(route, 3, 1, 1000, 0, 300, true)).toBe(2);
    expect(stepRoute(route, 3, 1, 0, 0, 300, true)).toBe(1);
    expect(stepRoute(route, 0, 0, 0, 0, 300, true)).toBe(0);
  });

  it('NavRoute: set, step leg by leg to -1; holds the planner cap; set again restarts', () => {
    expect(NAV_ROUTE_POINTS).toBe(NAV_ROUTE_MAX_POINTS);
    const r = createNavRoute();
    expect(stepNavRoute(r, 0, 0, 10)).toBe(-1); // empty
    setNavRoute(r, new Float64Array([500, 0, 500, 500]));
    expect(r.count).toBe(2);
    expect(stepNavRoute(r, 0, 0, 10)).toBe(0);
    expect(stepNavRoute(r, 495, 0, 10)).toBe(1);
    expect(stepNavRoute(r, 500, 495, 10)).toBe(-1);
    expect(stepNavRoute(r, 0, 0, 10)).toBe(-1);
    const long = new Float64Array((NAV_ROUTE_POINTS + 5) * 2).fill(7);
    setNavRoute(r, long);
    expect([r.count, r.leg]).toEqual([NAV_ROUTE_POINTS, 0]);
  });
});
