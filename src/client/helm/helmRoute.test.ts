import { describe, it, expect } from 'vitest';
import { HelmRouteClient, NAV_ROUTE_LOST_MS } from './helmRoute.js';
import type { HelmOrder } from '@core/helm/helm';
import { NAV_ROUTE_MIN_GAP_MS, NavRouteRequestSchema, type NavRouteRequest } from '../../shared-types/messages/navMessages.js';

function setup() {
  const sent: NavRouteRequest[] = [];
  const c = new HelmRouteClient((_t, m) => { sent.push({ ...m }); });
  const order: HelmOrder = { active: true, tx: 1000, ty: 0, speed: 3 };
  return { sent, c, order };
}
const reply = (reqId: number, status: string, points: number[]) => ({ type: 'nav_route', reqId, status, points });

describe('HelmRouteClient (autopilot, navigation slice 13)', () => {
  it('a course asks once, with a message the server schema accepts', () => {
    const { sent, c, order } = setup();
    c.course(order, 0);
    expect(sent).toHaveLength(1);
    expect(NavRouteRequestSchema.safeParse(sent[0]).success).toBe(true);
    expect(sent[0]).toMatchObject({ tx: 1000, ty: 0 });
  });

  it('a route reply loads the waypoints; the order point becomes the route end', () => {
    const { sent, c, order } = setup();
    c.course(order, 0);
    expect(c.onReply(reply(sent[0]!.reqId, 'route', [0, 500, 1000, 0]), order)).toBe('route');
    expect(order.route).toBe(c.route);
    expect(c.route.n).toBe(2);
    expect([order.tx, order.ty]).toEqual([1000, 0]);
  });

  it('nearest moves the point to where the way ends; none asks to end the order; straight keeps flying straight', () => {
    const a = setup();
    a.c.course(a.order, 0);
    a.c.onReply(reply(a.sent[0]!.reqId, 'nearest', [200, 300, 400, 500]), a.order);
    expect([a.order.tx, a.order.ty]).toEqual([400, 500]);
    const b = setup();
    b.c.course(b.order, 0);
    expect(b.c.onReply(reply(b.sent[0]!.reqId, 'none', []), b.order)).toBe('end');
    const s = setup();
    s.c.course(s.order, 0);
    s.c.onReply(reply(s.sent[0]!.reqId, 'straight', []), s.order);
    expect(s.order.route ?? null).toBeNull();
    expect(s.order.active).toBe(true);
  });

  it('keeps the server rate: a quick second tap waits for the reply and the gap, and the old reply is ignored', () => {
    const { sent, c, order } = setup();
    c.course(order, 0);
    order.tx = 2000;
    c.course(order, 100);
    expect(sent).toHaveLength(1); // in flight: wait
    expect(c.onReply(reply(sent[0]!.reqId, 'route', [0, 500, 1000, 0]), order)).toBe('keep'); // stale
    expect(order.route ?? null).toBeNull();
    c.tick(NAV_ROUTE_MIN_GAP_MS - 1);
    expect(sent).toHaveLength(1);
    c.tick(NAV_ROUTE_MIN_GAP_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.tx).toBe(2000);
  });

  it('a lost reply is asked again; a cancelled course ignores late replies', () => {
    const { sent, c, order } = setup();
    c.course(order, 0);
    order.tx = 3000;
    c.course(order, 10);
    c.tick(NAV_ROUTE_LOST_MS + 1);
    expect(sent).toHaveLength(2);
    c.clear();
    expect(c.onReply(reply(sent[1]!.reqId, 'route', [1, 2]), order)).toBe('keep');
  });

  it('a malformed reply is dropped', () => {
    const { c, order } = setup();
    c.course(order, 0);
    expect(c.onReply({ type: 'nav_route', reqId: 1, status: 'bogus', points: [] }, order)).toBe('keep');
  });
});
