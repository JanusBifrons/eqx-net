import { describe, it, expect } from 'vitest';
import { NavRouteRequestSchema, NavRouteReplySchema, NAV_ROUTE_REPLY_MAX_POINTS, NAV_ROUTE_STATUSES, NAV_ROUTE_COORD_MAX } from './navMessages.js';
import { NAV_ROUTE_MAX_POINTS, RoutePlanner } from '../../core/nav/routePlanner.js';

describe('nav_route wire (navigation slice 12)', () => {
  it('a request is a goal and a request number, nothing else', () => {
    expect(NavRouteRequestSchema.safeParse({ type: 'nav_route_request', reqId: 3, tx: 100, ty: -200 }).success).toBe(true);
    expect(NavRouteRequestSchema.safeParse({ type: 'nav_route_request', reqId: 3, tx: 100, ty: -200, sx: 0 }).success).toBe(false); // strict: no client start
    expect(NavRouteRequestSchema.safeParse({ type: 'nav_route_request', reqId: -1, tx: 0, ty: 0 }).success).toBe(false);
    expect(NavRouteRequestSchema.safeParse({ type: 'nav_route_request', reqId: 1.5, tx: 0, ty: 0 }).success).toBe(false);
    expect(NavRouteRequestSchema.safeParse({ type: 'nav_route_request', reqId: 1, tx: Infinity, ty: 0 }).success).toBe(false);
    expect(NavRouteRequestSchema.safeParse({ type: 'nav_route_request', reqId: 1, tx: NAV_ROUTE_COORD_MAX * 2, ty: 0 }).success).toBe(false);
  });

  it('the reply fits every route the planner can make (both sides of the wire agree, #15)', () => {
    expect(NAV_ROUTE_REPLY_MAX_POINTS).toBe(NAV_ROUTE_MAX_POINTS);
    const statuses: ReturnType<() => RoutePlanner['status']>[] = [...NAV_ROUTE_STATUSES];
    expect(statuses.sort()).toEqual(['nearest', 'none', 'route', 'straight']);
    const full = Array.from({ length: NAV_ROUTE_MAX_POINTS * 2 }, (_, i) => i);
    expect(NavRouteReplySchema.safeParse({ type: 'nav_route', reqId: 0, status: 'route', points: full }).success).toBe(true);
    expect(NavRouteReplySchema.safeParse({ type: 'nav_route', reqId: 0, status: 'route', points: [...full, 1, 2] }).success).toBe(false);
  });
});
