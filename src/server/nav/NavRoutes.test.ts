import { describe, it, expect } from 'vitest';
import { NavRoutes, type NavRouteRequest } from './NavRoutes.js';
import type { NavRouteMsg } from '../../core/nav/navHost.js';
import type { NavHull } from '../../shared-types/shipScale/navTuning.js';

/** A 30 u hull (clearance = comfort = beam). */
const H: NavHull = { clearance: 30, comfort: 30, beam: 30, turnRate: 4 };
const CAP: NavHull = { clearance: 3000, comfort: 3000, beam: 3000, turnRate: 0.02 };

/** A request stub: records each ask; `answer` resolves the latest. */
function stub(): { request: NavRouteRequest; asks: number[][]; turns: number[][]; answer: (msg: Partial<NavRouteMsg>) => Promise<void> } {
  const asks: number[][] = [];
  const turns: number[][] = [];
  let resolve: ((m: NavRouteMsg) => void) | null = null;
  return {
    asks, turns,
    request: (sx, sy, tx, ty, h, hd, tr) => {
      asks.push([sx, sy, tx, ty, h.clearance]);
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
    expect(nav.waypoint('a', 0, 0, 1000, 0, H, 50)).toBe(false);
    expect(nav.waypoint('a', 1, 0, 1000, 0, H, 50)).toBe(false); // same goal, pending: no second ask
    expect(s.asks).toEqual([[0, 0, 1000, 0, 30]]);
    await s.answer({ points: new Float64Array([500, 400, 1000, 0]) });
    expect(nav.waypoint('a', 10, 0, 1000, 0, H, 50)).toBe(true);
    expect([nav.turnX, nav.turnY]).toEqual([500, 400]);
    // Ahead: to the corner plus the next leg as far as it runs the same way as the
    // incoming leg (from the plan's start), capped by what the ship can still turn
    // within its swing (a fifth of its clearance): swing / sin²θ.
    const d = Math.hypot(490, 400), leg = Math.hypot(500, 400), cos = (500 * 500 + 400 * -400) / (leg * leg);
    expect(nav.ahead).toBeCloseTo(d + Math.min(leg * cos, (30 * 0.2) / (1 - cos * cos)), 6);
    expect(nav.ahead).toBeLessThan(d + 10); // a 77° corner: brake almost to it
    // Inside arrive but short of the turn (the plan started at (0, 0)): it holds the turn.
    expect(nav.waypoint('a', 480, 390, 1000, 0, H, 50)).toBe(true);
    expect([nav.turnX, nav.turnY]).toEqual([500, 400]);
    expect(nav.waypoint('a', 505, 398, 1000, 0, H, 50)).toBe(true); // level with the turn (a turn is flown, not cut)
    expect([nav.turnX, nav.turnY]).toEqual([1000, 0]);
    expect(nav.ahead).toBeCloseTo(Math.hypot(495, 398), 6); // last leg: brake for the goal
    expect(nav.waypoint('a', 990, 0, 1000, 0, H, 50)).toBe(false); // finished: fly the last bit as before
    expect(nav.requests).toBe(1);
    expect(nav.routed).toBe(1);
  });

  it('straight / none answers leave no waypoint; a moved goal re-plans at most once a second', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 1000, 0, H, 50);
    await s.answer({ status: 'straight', points: new Float64Array([1000, 0]) });
    expect(nav.waypoint('a', 0, 0, 1000, 0, H, 50)).toBe(false);
    expect(nav.waypoint('a', 0, 0, 1000, 40, H, 50)).toBe(false); // moved inside arrive: same goal
    expect(s.asks.length).toBe(1);
    now = 500;
    nav.waypoint('a', 0, 0, 0, 2000, H, 50); // new goal, too soon
    expect(s.asks.length).toBe(1);
    now = 1000;
    nav.waypoint('a', 0, 0, 0, 2000, H, 50);
    expect(s.asks.length).toBe(2);
    await s.answer({ status: 'none' });
    expect(nav.waypoint('a', 0, 0, 0, 2000, H, 50)).toBe(false);
  });

  it('an answer for an old goal is dropped; idle ships are forgotten', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 1000, 0, H, 50);
    const first = s.answer; // holds the first request's resolver
    now = 2000;
    nav.waypoint('a', 0, 0, -1000, 0, H, 50); // new goal while the first is pending: waits
    expect(s.asks.length).toBe(1);
    await first({ points: new Float64Array([500, 400, 1000, 0]) }); // answer for the OLD goal
    expect(nav.waypoint('a', 0, 0, -1000, 0, H, 50)).toBe(false); // not flown; asks for the new goal
    expect(s.asks.length).toBe(2);
    nav.waypoint('b', 0, 0, 5, 5, H, 50);
    expect(nav.size).toBe(2);
    now = 30_000;
    nav.waypoint('b', 0, 0, 5, 5, H, 50);
    expect(nav.size).toBe(1);
  });
  it('no way fits (nearest, slice 9): flies to the route end and waits there until the goal changes', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 1000, 0, H, 50);
    await s.answer({ status: 'nearest', points: new Float64Array([300, 200, 600, 0]) });
    expect(nav.short).toBe(1);
    expect(nav.routed).toBe(0);
    expect(nav.waypoint('a', 10, 0, 1000, 0, H, 50)).toBe(true);
    expect([nav.turnX, nav.turnY]).toEqual([300, 200]);
    expect(nav.waypoint('a', 302, 199, 1000, 0, H, 50)).toBe(true); // level with the turn
    expect([nav.turnX, nav.turnY]).toEqual([600, 0]);
    // Arrived at the end: it stays the waypoint (wait), never the goal past it.
    expect(nav.waypoint('a', 600, 0, 1000, 0, H, 50)).toBe(true);
    expect([nav.turnX, nav.turnY]).toEqual([600, 0]);
    expect(nav.ahead).toBeCloseTo(0, 6);
    now = 5_000;
    expect(nav.waypoint('a', 605, 3, 1000, 0, H, 50)).toBe(true);
    expect(s.asks.length).toBe(1);
    // A new goal drops the wait.
    expect(nav.waypoint('a', 600, 0, 0, 3000, H, 50)).toBe(false);
    expect(s.asks.length).toBe(2);
  });
  it('stuck (slice 9): no progress for 4 s plans again from here, twice; then it waits there and retries every 10 s', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 2000, 0, H, 50);
    await s.answer({ status: 'route', points: new Float64Array([1000, 500, 2000, 0]) });
    // Moving well: no re-plan.
    now = 4_000; nav.waypoint('a', 400, 200, 2000, 0, H, 50);
    expect(s.asks.length).toBe(1);
    // Pinned near (420, 210) from here on.
    now = 8_000; nav.waypoint('a', 420, 210, 2000, 0, H, 50);
    expect(s.asks.length).toBe(2);
    expect(s.asks[1]!.slice(0, 2)).toEqual([420, 210]);
    await s.answer({ status: 'route', points: new Float64Array([1000, 500, 2000, 0]) });
    now = 12_000; nav.waypoint('a', 425, 205, 2000, 0, H, 50);
    expect(s.asks.length).toBe(3);
    await s.answer({ status: 'route', points: new Float64Array([1000, 500, 2000, 0]) });
    expect(nav.stuckReplans).toBe(2);
    expect(nav.waiting('a')).toBe(false);
    // Third time: wait where it is.
    now = 16_000;
    expect(nav.waypoint('a', 422, 208, 2000, 0, H, 50)).toBe(true);
    expect([nav.turnX, nav.turnY]).toEqual([422, 208]);
    expect(nav.waiting('a')).toBe(true);
    expect(nav.held).toBe(1);
    expect(s.asks.length).toBe(3);
    now = 25_000; nav.waypoint('a', 422, 208, 2000, 0, H, 50);
    expect(s.asks.length).toBe(3);
    now = 26_000; nav.waypoint('a', 422, 208, 2000, 0, H, 50);
    expect(s.asks.length).toBe(4);
    // The way has opened: back to flying.
    await s.answer({ status: 'straight', points: new Float64Array([2000, 0]) });
    expect(nav.waiting('a')).toBe(false);
    expect(nav.waypoint('a', 422, 208, 2000, 0, H, 50)).toBe(false);
  });

  it('close to the goal is not stuck (the brain is stopping there)', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 2000, 0, H, 50);
    await s.answer({ status: 'straight', points: new Float64Array([2000, 0]) });
    for (now = 4_000; now <= 20_000; now += 4_000) nav.waypoint('a', 1920, 0, 2000, 0, H, 50);
    expect(s.asks.length).toBe(1);
    expect(nav.stuckReplans).toBe(0);
  });
  it('keep (a moving goal, slice 10): the old route flies on until the new plan answers', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 1000, 0, H, 50, true);
    await s.answer({ points: new Float64Array([500, 400, 1000, 0]) });
    now = 1_000;
    expect(nav.waypoint('a', 10, 0, 1100, 0, H, 50, true)).toBe(true); // goal moved: re-asks, old route kept
    expect([nav.turnX, nav.turnY]).toEqual([500, 400]);
    expect(s.asks.length).toBe(2);
    await s.answer({ points: new Float64Array([600, 300, 1100, 0]) });
    expect(nav.waypoint('a', 10, 0, 1100, 0, H, 50, true)).toBe(true);
    expect([nav.turnX, nav.turnY]).toEqual([600, 300]);
  });

  it('aims along the leg, not at its corner: a ship off the line steers back onto it', async () => {
    const s = stub(), nav = new NavRoutes(s.request, () => 0);
    nav.waypoint('a', 0, 0, 1000, 0, H, 50);
    await s.answer({ points: new Float64Array([500, 0, 1000, 500]) });
    // 40 u off the first leg at x = 100: aim at x = 100 + arrive on the line itself.
    expect(nav.waypoint('a', 100, 40, 1000, 0, H, 50)).toBe(true);
    expect([nav.turnX, nav.turnY]).toEqual([500, 0]);
    expect(nav.wpX).toBeCloseTo(150, 6);
    expect(nav.wpY).toBeCloseTo(0, 6);
    expect(nav.ahead).toBeGreaterThanOrEqual(Math.hypot(400, 40)); // braking still counts from the corner
    // Within arrive of the corner along the leg: aim at the corner.
    expect(nav.waypoint('a', 470, 10, 1000, 0, H, 50)).toBe(true);
    expect([nav.wpX, nav.wpY]).toEqual([500, 0]);
  });

  it('with no nose given, holds a sharp corner\'s turn speed for as long as a nose takes to come round; a gentle corner barely slows', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    nav.waypoint('a', 0, 0, 1000, 0, H, 50);
    // A 76° left turn at (500, 0), then a 76° right turn at (620, 480).
    await s.answer({ points: new Float64Array([500, 0, 620, 480, 1100, 600]) });
    expect(nav.waypoint('a', 400, 0, 1000, 0, H, 50)).toBe(true);
    expect(nav.turnSpeed).toBe(Infinity); // short of the corner: braking is `ahead`'s
    expect(nav.waypoint('a', 501, 0, 1000, 0, H, 50)).toBe(true); // level: the corner is passed
    const l1 = Math.hypot(120, 480), cos1 = 120 / l1, theta1 = Math.acos(cos1);
    // The swing a nose turning θ at ω leaves, v·sin²θ / 2ω, within a fifth of the clearance.
    const hold1 = (2 * H.turnRate * 30 * 0.2) / (1 - cos1 * cos1);
    expect(nav.turnSpeed).toBeCloseTo(hold1, 6);
    expect(hold1).toBeLessThan(60); // a fighter's 4 rad/s nose: crawl round, don't cruise off at the old heading
    now = 1000 * 1.5 * theta1 / H.turnRate - 1; // held while the nose is still coming round (with margin)
    nav.waypoint('a', 505, 10, 1000, 0, H, 50);
    expect(nav.turnSpeed).toBeCloseTo(hold1, 6);
    now += 2; // nose round: back to the leg's own speed
    nav.waypoint('a', 510, 30, 1000, 0, H, 50);
    expect(nav.turnSpeed).toBe(Infinity);
    // The next corner: (120, 480) → (480, 120), 62°: a slower nose (1 rad/s) takes it slower.
    const slow: NavHull = { ...H, turnRate: 1 };
    nav.waypoint('a', 621, 481, 1000, 0, slow, 50);
    const cos2 = (120 * 480 + 480 * 120) / (l1 * Math.hypot(480, 120));
    expect(nav.turnSpeed).toBeCloseTo((2 * 1 * 30 * 0.2) / (1 - cos2 * cos2), 6);
    // A gentle 15° corner allows far more speed than a sharp one (sin²θ).
    const g = stub(), gn = new NavRoutes(g.request, () => 0);
    gn.waypoint('b', 0, 0, 1000, 0, H, 50);
    await g.answer({ points: new Float64Array([500, 0, 1000, Math.tan(Math.PI / 12) * 500]) });
    gn.waypoint('b', 501, 0, 1000, 0, H, 50);
    expect(gn.turnSpeed).toBeGreaterThan(10 * hold1);
  });

  it('with the nose given, caps the speed out of a corner by what is left of its swing, until it is round', async () => {
    let now = 0;
    const s = stub(), nav = new NavRoutes(s.request, () => now);
    const east = -Math.PI / 2; // nose (-sin a, cos a) = (1, 0): still along the old leg
    nav.waypoint('a', 0, 0, 1000, 0, H, 50, false, east);
    await s.answer({ points: new Float64Array([500, 0, 620, 480, 1100, 600]) }); // a 76° left turn at (500, 0)
    nav.waypoint('a', 400, 0, 1000, 0, H, 50, false, east);
    expect(nav.turnSpeed).toBe(Infinity);
    nav.waypoint('a', 501, 0, 1000, 0, H, 50, false, east); // the corner passed, the nose not yet turned
    const ax = nav.wpX - 501, ay = nav.wpY, c = ax / Math.hypot(ax, ay); // nose · aim
    const cap = (2 * H.turnRate * 30 * 0.2) / (1 - c * c);
    expect(nav.turnSpeed).toBeCloseTo(cap, 6);
    expect(cap).toBeLessThan(60);
    now = 9_000; // no clock on it: a stalled ship stays held however long it sits (the timed hold ended at ~0.5 s)
    nav.waypoint('a', 501, 0, 1000, 0, H, 50, false, east);
    expect(nav.turnSpeed).toBeCloseTo(cap, 6);
    // Half round: the cap rises with the swing that is left.
    const half = east + Math.acos(c) / 2;
    nav.waypoint('a', 501, 0, 1000, 0, H, 50, false, half);
    expect(nav.turnSpeed).toBeGreaterThan(cap);
    // Round (the nose on the aim point): no cap, and the hold is over for this leg.
    nav.waypoint('a', 501, 0, 1000, 0, H, 50, false, Math.atan2(-ax, ay));
    expect(nav.turnSpeed).toBe(Infinity);
    nav.waypoint('a', 502, 1, 1000, 0, H, 50, false, east);
    expect(nav.turnSpeed).toBe(Infinity);
  });

  it('a hull asking with a turning radius (a capital, its plan already fitted to its turns) is not capped out of a corner', async () => {
    const s = stub(), nav = new NavRoutes(s.request, () => 0);
    const east = -Math.PI / 2;
    nav.waypoint('cap', 0, 0, 30_000, 0, CAP, 500, false, east, 7758);
    await s.answer({ points: new Float64Array([10_000, 0, 12_400, 9_600, 30_000, 14_000]) }); // the same 76° corner, capital-sized
    nav.waypoint('cap', 9_000, 0, 30_000, 0, CAP, 500, false, east, 7758);
    nav.waypoint('cap', 10_001, 0, 30_000, 0, CAP, 500, false, east, 7758); // past it, the nose still on the old leg
    expect(nav.turnSpeed).toBe(Infinity);
  });

  it('passes a capital nose and turning radius on to its plan; a plain ask sends none (slice 11)', () => {
    const s = stub(), nav = new NavRoutes(s.request, () => 0);
    nav.waypoint('cap', 0, 0, 9000, 0, CAP, 500, false, 1.25, 7758);
    nav.waypoint('f', 0, 0, 1000, 0, H, 50);
    nav.waypoint('g', 0, 0, 1000, 0, H, 50, false, 0.5); // a nose with no turning radius: the plan is not shaped by it
    expect(s.turns[0]).toEqual([1.25, 7758]);
    expect(s.turns[1]![0]).toBeNaN();
    expect(s.turns[1]![1]).toBe(0);
    expect(s.turns[2]![0]).toBeNaN();
  });
});
