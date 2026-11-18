import { describe, it, expect } from 'vitest';
import { NavRoutes, type NavRouteRequest } from './NavRoutes.js';
import type { NavRouteMsg } from '../../core/nav/navHost.js';

/** A request stub: records each ask; `answer` resolves the latest. */
function stub(): { request: NavRouteRequest; asks: number[][]; turns: number[][]; answer: (msg: Partial<NavRouteMsg>) => Promise<void> } {
  const asks: number[][] = [];
  const turns: number[][] = [];
  let resolve: ((m: NavRouteMsg) => void) | null = null;
  return {
    asks, turns,
    request: (sx, sy, tx, ty, c, hd, tr) => {
      asks.push([sx, sy, tx, ty, c]);
      turns.push([hd, tr]);
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
  it('no way fits (nearest, slice 9): flies to the route end and waits there until the goal changes', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 1000, 0, 30, 50);
    await s.answer({ status: 'nearest', points: new Float64Array([300, 200, 600, 0]) });
    expect(nav.short).toBe(1);
    expect(nav.routed).toBe(0);
    expect(nav.waypoint('a', 10, 0, 1000, 0, 30, 50)).toBe(true);
    expect([nav.wpX, nav.wpY]).toEqual([300, 200]);
    expect(nav.waypoint('a', 290, 190, 1000, 0, 30, 50)).toBe(true);
    expect([nav.wpX, nav.wpY]).toEqual([600, 0]);
    // Arrived at the end: it stays the waypoint (wait), never the goal past it.
    expect(nav.waypoint('a', 600, 0, 1000, 0, 30, 50)).toBe(true);
    expect([nav.wpX, nav.wpY]).toEqual([600, 0]);
    expect(nav.ahead).toBeCloseTo(0, 6);
    now = 5_000;
    expect(nav.waypoint('a', 605, 3, 1000, 0, 30, 50)).toBe(true);
    expect(s.asks.length).toBe(1);
    // A new goal drops the wait.
    expect(nav.waypoint('a', 600, 0, 0, 3000, 30, 50)).toBe(false);
    expect(s.asks.length).toBe(2);
  });
  it('stuck (slice 9): no progress for 4 s plans again from here, twice; then it waits there and retries every 10 s', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 2000, 0, 30, 50);
    await s.answer({ status: 'route', points: new Float64Array([1000, 500, 2000, 0]) });
    // Moving well: no re-plan.
    now = 4_000; nav.waypoint('a', 400, 200, 2000, 0, 30, 50);
    expect(s.asks.length).toBe(1);
    // Pinned near (420, 210) from here on.
    now = 8_000; nav.waypoint('a', 420, 210, 2000, 0, 30, 50);
    expect(s.asks.length).toBe(2);
    expect(s.asks[1]!.slice(0, 2)).toEqual([420, 210]);
    await s.answer({ status: 'route', points: new Float64Array([1000, 500, 2000, 0]) });
    now = 12_000; nav.waypoint('a', 425, 205, 2000, 0, 30, 50);
    expect(s.asks.length).toBe(3);
    await s.answer({ status: 'route', points: new Float64Array([1000, 500, 2000, 0]) });
    expect(nav.stuckReplans).toBe(2);
    expect(nav.waiting('a')).toBe(false);
    // Third time: wait where it is.
    now = 16_000;
    expect(nav.waypoint('a', 422, 208, 2000, 0, 30, 50)).toBe(true);
    expect([nav.wpX, nav.wpY]).toEqual([422, 208]);
    expect(nav.waiting('a')).toBe(true);
    expect(nav.held).toBe(1);
    expect(s.asks.length).toBe(3);
    now = 25_000; nav.waypoint('a', 422, 208, 2000, 0, 30, 50);
    expect(s.asks.length).toBe(3);
    now = 26_000; nav.waypoint('a', 422, 208, 2000, 0, 30, 50);
    expect(s.asks.length).toBe(4);
    // The way has opened: back to flying.
    await s.answer({ status: 'straight', points: new Float64Array([2000, 0]) });
    expect(nav.waiting('a')).toBe(false);
    expect(nav.waypoint('a', 422, 208, 2000, 0, 30, 50)).toBe(false);
  });

  it('close to the goal is not stuck (the brain is stopping there)', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 2000, 0, 30, 50);
    await s.answer({ status: 'straight', points: new Float64Array([2000, 0]) });
    for (now = 4_000; now <= 20_000; now += 4_000) nav.waypoint('a', 1920, 0, 2000, 0, 30, 50);
    expect(s.asks.length).toBe(1);
    expect(nav.stuckReplans).toBe(0);
  });
  it('keep (a moving goal, slice 10): the old route flies on until the new plan answers', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 1000, 0, 30, 50, true);
    await s.answer({ points: new Float64Array([500, 400, 1000, 0]) });
    now = 1_000;
    expect(nav.waypoint('a', 10, 0, 1100, 0, 30, 50, true)).toBe(true); // goal moved: re-asks, old route kept
    expect([nav.wpX, nav.wpY]).toEqual([500, 400]);
    expect(s.asks.length).toBe(2);
    await s.answer({ points: new Float64Array([600, 300, 1100, 0]) });
    expect(nav.waypoint('a', 10, 0, 1100, 0, 30, 50, true)).toBe(true);
    expect([nav.wpX, nav.wpY]).toEqual([600, 300]);
  });

  it('passes a capital nose and turning radius on to its plan; a plain ask sends none (slice 11)', () => {
    const s = stub(), nav = new NavRoutes(s.request, () => 0);
    nav.waypoint('cap', 0, 0, 9000, 0, 3000, 500, false, 1.25, 7758);
    nav.waypoint('f', 0, 0, 1000, 0, 30, 50);
    expect(s.turns[0]).toEqual([1.25, 7758]);
    expect(s.turns[1]![0]).toBeNaN();
    expect(s.turns[1]![1]).toBe(0);
  });
});
