import { z } from 'zod';

/**
 * Navigation slice 12: the player's autopilot asks the server for a route.
 *
 * Client → server `nav_route_request`: "a way from my ship to (tx, ty)". The
 * server plans it on the nav worker for the asker's own active hull (its pose,
 * clearance and, for a capital, nose and turning radius, all server-side) and
 * answers `nav_route` to that client only. The reply is advice for the
 * client's helm, which flies it with ordinary inputs (slice 13): nothing in it
 * is authoritative state, so a lost reply only means the client asks again.
 *
 * Rate: one request in flight per player, at most one per
 * `NAV_ROUTE_MIN_GAP_MS` (game time); anything over is dropped silently.
 */

/** Largest world coordinate a request may name (sectors are far smaller). */
export const NAV_ROUTE_COORD_MAX = 10_000_000;
/** Game ms between one player's route requests. */
export const NAV_ROUTE_MIN_GAP_MS = 500;
/** Waypoints in a reply at most (the planner's `NAV_ROUTE_MAX_POINTS`). */
export const NAV_ROUTE_REPLY_MAX_POINTS = 64;

const coord = z.number().finite().min(-NAV_ROUTE_COORD_MAX).max(NAV_ROUTE_COORD_MAX);

export const NavRouteRequestSchema = z.object({
  type: z.literal('nav_route_request'),
  /** The client's own number for this request, echoed in the reply. */
  reqId: z.number().int().min(0).max(0x7fffffff),
  tx: coord,
  ty: coord,
}).strict();
export type NavRouteRequest = z.infer<typeof NavRouteRequestSchema>;

/**
 * `straight`: fly straight at the goal. `route`: fly the points in order (the
 * last is the goal). `nearest`: no way fits; the points end as close as the
 * ship can get. `none`: no way and nothing nearer than where it is.
 */
export const NAV_ROUTE_STATUSES = ['straight', 'route', 'nearest', 'none'] as const;
export type NavRouteStatus = (typeof NAV_ROUTE_STATUSES)[number];

export const NavRouteReplySchema = z.object({
  type: z.literal('nav_route'),
  reqId: z.number().int().min(0).max(0x7fffffff),
  status: z.enum(NAV_ROUTE_STATUSES),
  /** Waypoints after the start, packed x, y. */
  points: z.array(z.number().finite()).max(NAV_ROUTE_REPLY_MAX_POINTS * 2),
}).strict();
export type NavRouteReply = z.infer<typeof NavRouteReplySchema>;
