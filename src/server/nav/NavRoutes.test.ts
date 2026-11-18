import { describe, it, expect } from 'vitest';
import { NavRoutes, type NavRouteRequest } from './NavRoutes.js';
import type { NavRouteMsg } from '../../core/nav/navHost.js';

/** A request stub: records each ask; `answer` resolves the latest. */
function stub(): { request: NavRouteRequest; asks: number[][]; answer: (msg: Partial<NavRouteMsg>) => Promise<void> } {
  const asks: number[][] = [];
  let resolve: ((m: NavRouteMsg) => void) | null = null;
  return {
    asks,
    request: (sx, sy, tx, ty, c) => {
      asks.push([sx, sy, tx, ty, c]);
      return new Promise<NavRouteMsg>((r) => { resolve = r; });
    },
    answer: async (msg) => {
      resolve!({ type: 'ROUTE', worldId: 1, reqId: 1, status: 'route', points: new Float64Array(0), expanded: 0, ms: 0, ...msg });
      await Promise.resolve(); await Promise.resolve();
    },
  };
}

describe('NavRoutes (each ship\'s route to its goal, navigation slice 7)', () => {
  it('a new goal asks once; no waypoint until the answer; then legs to the goal and done', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    expect(nav.waypoint('a', 0, 0, 1000, 0, 30, 50)).toBe(false);
    expect(nav.waypoint('a', 1, 0, 1000, 0, 30, 50)).toBe(false); // same goal, pending: no second ask
    expect(s.asks).toEqual([[0, 0, 1000, 0, 30]]);
    await s.answer({ points: new Float64Array([500, 400, 1000, 0]) });
    expect(nav.waypoint('a', 10, 0, 1000, 0, 30, 50)).toBe(true);
    expect([nav.wpX, nav.wpY]).toEqual([500, 400]);
    // Ahead: to the corner plus the next leg as far as it runs the same way.
    const d = Math.hypot(490, 400), leg = Math.hypot(500, 400), cos = (490 * 500 + 400 * -400) / (d * leg);
    expect(nav.ahead).toBeCloseTo(d + leg * Math.max(0, cos), 6);
    expect(nav.waypoint('a', 480, 390, 1000, 0, 30, 50)).toBe(true);
    expect([nav.wpX, nav.wpY]).toEqual([1000, 0]);
    expect(nav.ahead).toBeCloseTo(Math.hypot(520, 390), 6); // last leg: brake for the goal
    expect(nav.waypoint('a', 990, 0, 1000, 0, 30, 50)).toBe(false); // finished: fly the last bit as before
    expect(nav.requests).toBe(1);
    expect(nav.routed).toBe(1);
  });

  it('straight / none answers leave no waypoint; a moved goal re-plans at most once a second', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 1000, 0, 30, 50);
    await s.answer({ status: 'straight', points: new Float64Array([1000, 0]) });
    expect(nav.waypoint('a', 0, 0, 1000, 0, 30, 50)).toBe(false);
    expect(nav.waypoint('a', 0, 0, 1000, 40, 30, 50)).toBe(false); // moved inside arrive: same goal
    expect(s.asks.length).toBe(1);
    now = 500;
    nav.waypoint('a', 0, 0, 0, 2000, 30, 50); // new goal, too soon
    expect(s.asks.length).toBe(1);
    now = 1000;
    nav.waypoint('a', 0, 0, 0, 2000, 30, 50);
    expect(s.asks.length).toBe(2);
    await s.answer({ status: 'none' });
    expect(nav.waypoint('a', 0, 0, 0, 2000, 30, 50)).toBe(false);
  });

  it('an answer for an old goal is dropped; idle ships are forgotten', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 1000, 0, 30, 50);
    const first = s.answer; // holds the first request's resolver
    now = 2000;
    nav.waypoint('a', 0, 0, -1000, 0, 30, 50); // new goal while the first is pending: waits
    expect(s.asks.length).toBe(1);
    await first({ points: new Float64Array([500, 400, 1000, 0]) }); // answer for the OLD goal
    expect(nav.waypoint('a', 0, 0, -1000, 0, 30, 50)).toBe(false); // not flown; asks for the new goal
    expect(s.asks.length).toBe(2);
    nav.waypoint('b', 0, 0, 5, 5, 30, 50);
    expect(nav.size).toBe(2);
    now = 30_000;
    nav.waypoint('b', 0, 0, 5, 5, 30, 50);
    expect(nav.size).toBe(1);
  });
});
