import { describe, it, expect } from 'vitest';
import { AutopilotRoutes, type AutopilotRouteFn } from './AutopilotRoutes.js';
import type { NavRouteMsg } from '../../core/nav/navHost.js';
import type { NavRouteReply } from '../../shared-types/messages/navMessages.js';
import { NAV_ROUTE_MIN_GAP_MS } from '../../shared-types/messages/navMessages.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipBodyMass, shipTuning } from '../../shared-types/shipScale/tuning.js';
import { makePilotHandling, pilotTurnRadius } from '../../core/ai/virtualPilot.js';

/** A route stub: records each ask; `answer` resolves the oldest open one. */
function stub() {
  const asks: number[][] = [];
  const open: ((m: NavRouteMsg) => void)[] = [];
  const fn: NonNullable<AutopilotRouteFn> = (sx, sy, tx, ty, c, hd, tr) => {
    asks.push([sx, sy, tx, ty, c, hd, tr]);
    return new Promise<NavRouteMsg>((r) => { open.push(r); });
  };
  const answer = async (points: number[]) => {
    open.shift()!({ type: 'ROUTE', worldId: 1, reqId: 0, status: 'route', points: new Float64Array(points), expanded: 0, ms: 0 });
    await Promise.resolve(); await Promise.resolve();
  };
  return { fn, asks, answer };
}

const fighter = { x: 10, y: 20, angle: 0.5, kind: 'fighter' };

describe('AutopilotRoutes (navigation slice 12)', () => {
  it('plans from the asker\'s own hull with its own clearance, and replies with the points', async () => {
    const s = stub(), got: NavRouteReply[] = [];
    const ap = new AutopilotRoutes(() => s.fn, () => 0);
    ap.request('p', fighter, 7, 5000, 0, (r) => got.push(r));
    expect(s.asks[0]!.slice(0, 5)).toEqual([10, 20, 5000, 0, shipTuning(getShipKind('fighter')).navClearance]);
    expect(s.asks[0]![5]).toBeNaN(); // a fighter sends no nose
    expect(s.asks[0]![6]).toBe(0);
    await s.answer([2500, 900, 5000, 0]);
    expect(got).toEqual([{ type: 'nav_route', reqId: 7, status: 'route', points: [2500, 900, 5000, 0] }]);
  });

  it('a capital plans with its nose and turning radius (slice 11 rules for the player too)', () => {
    const s = stub();
    new AutopilotRoutes(() => s.fn, () => 0).request('p', { x: 0, y: 0, angle: 1.1, kind: 'battleship' }, 1, 9e4, 0, () => {});
    const bs = getShipKind('battleship');
    expect(s.asks[0]![5]).toBe(1.1);
    expect(s.asks[0]![6]).toBeCloseTo(pilotTurnRadius(makePilotHandling(bs, shipBodyMass(bs))), 6);
  });

  it('one request in flight and one per gap per player; over that is dropped without a reply', async () => {
    let now = 0;
    const s = stub(), got: NavRouteReply[] = [];
    const ap = new AutopilotRoutes(() => s.fn, () => now);
    const ask = (id: string, req: number) => ap.request(id, fighter, req, 100, 100, (r) => got.push(r));
    ask('p', 1);
    now += NAV_ROUTE_MIN_GAP_MS * 4;
    ask('p', 2); // still in flight
    ask('q', 3); // another player is not held up
    expect(s.asks.length).toBe(2);
    expect(ap.dropped).toBe(1);
    await s.answer([100, 100]);
    ask('p', 4); // answered, gap long past: goes
    now += 1;
    await s.answer([100, 100]); // q's
    await s.answer([100, 100]); // p's 4
    ask('p', 5); // answered but inside the gap: dropped
    expect(s.asks.length).toBe(3);
    expect(ap.dropped).toBe(2);
    expect(got.map((r) => r.reqId)).toEqual([1, 3, 4]);
  });

  it('a room with no rock field answers straight at once', () => {
    const got: NavRouteReply[] = [];
    new AutopilotRoutes(() => null, () => 0).request('p', fighter, 9, 1, 1, (r) => got.push(r));
    expect(got).toEqual([{ type: 'nav_route', reqId: 9, status: 'straight', points: [] }]);
  });

  it('a failed plan frees the player to ask again', async () => {
    let fail: ((e: unknown) => void) | null = null;
    const fn: NonNullable<AutopilotRouteFn> = () => new Promise<NavRouteMsg>((_r, rej) => { fail = rej; });
    let now = 0;
    const ap = new AutopilotRoutes(() => fn, () => now);
    ap.request('p', fighter, 1, 1, 1, () => {});
    fail!(new Error('worker gone'));
    await Promise.resolve(); await Promise.resolve();
    now += NAV_ROUTE_MIN_GAP_MS;
    ap.request('p', fighter, 2, 1, 1, () => {});
    expect(ap.dropped).toBe(0);
  });
});
