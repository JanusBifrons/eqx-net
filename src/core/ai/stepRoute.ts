/**
 * The ONE route stepper (RTS Part B slice 11; open mode: navigation slice 6).
 * A route is waypoints packed flat (`x0, y0, x1, y1, ...`). A ship flying to
 * waypoint `leg` that is within `arrive` of it moves on to the next one.
 * A patrol loop wraps last → first; an open route (`open`, a nav route to a
 * goal) runs out instead: past the last waypoint it returns `count`.
 *
 * Shared by the garrison patrols (`PatrolSubsystem`), an owned ship's fleet
 * Patrol mode (the route its fleet orders keep, `server/fleet/fleetShipOrders`)
 * and nav routes ({@link NavRoute}). Pure, allocation-free.
 *
 * @returns the waypoint index to fly to now (`leg`, the next one, or
 *   `count` when an open route is finished).
 */
export function stepRoute(
  points: ArrayLike<number>,
  count: number,
  leg: number,
  x: number,
  y: number,
  arrive: number,
  open = false,
): number {
  if (count <= 0) return open ? count : 0;
  if (open && leg >= count) return count;
  const dx = points[leg * 2]! - x;
  const dy = points[leg * 2 + 1]! - y;
  if (dx * dx + dy * dy > arrive * arrive) return leg;
  return open ? leg + 1 : (leg + 1) % count;
}

/** Most waypoints a nav route holds (the planner's cap, `NAV_ROUTE_MAX_POINTS`). */
export const NAV_ROUTE_POINTS = 64;

/** A ship's nav route to a goal: the waypoints the route planner answered
 *  (open, the goal last; the planner writes the points after the start) and
 *  the one being flown to. Kept beside the fleet orders' patrol route,
 *  walked by the same {@link stepRoute}. */
export interface NavRoute {
  /** Waypoints, packed x, y (`count` of them). */
  readonly points: Float64Array;
  count: number;
  /** The waypoint being flown to. */
  leg: number;
  /** Where the route starts (the plan's start, the first turn's incoming leg); NaN unknown. */
  sx: number;
  sy: number;
}

/** An empty route with room for {@link NAV_ROUTE_POINTS} waypoints. */
export function createNavRoute(): NavRoute {
  return { points: new Float64Array(NAV_ROUTE_POINTS * 2), count: 0, leg: 0, sx: NaN, sy: NaN };
}

/** Loads the planner's waypoints (packed x, y; the goal last), cut to fit,
 *  and the start they were planned from. */
export function setNavRoute(r: NavRoute, points: ArrayLike<number>, sx = NaN, sy = NaN): void {
  const n = Math.min(points.length >> 1, NAV_ROUTE_POINTS);
  for (let k = 0; k < n * 2; k++) r.points[k] = points[k]!;
  r.count = n;
  r.leg = 0;
  r.sx = sx; r.sy = sy;
}

/** Steps the route for a ship at (x, y); returns the waypoint index to fly to,
 *  or -1 when the route is finished (or empty).
 *
 *  A turn (any waypoint before the goal) is passed only once the ship, inside
 *  `arrive`, has drawn level with it along the leg it flies in on (from the
 *  waypoint before, or the route's start for the first). The planner's turns
 *  hug rock at the hull's clearance, so leaving one from `arrive` short flies
 *  the chord across the corner and into the rock on its inside (a fighter's
 *  80 u arrive against its 30 u clearance). With no start known, the first
 *  waypoint is passed by distance alone. */
export function stepNavRoute(r: NavRoute, x: number, y: number, arrive: number): number {
  const leg = r.leg, p = r.points;
  if (leg < r.count - 1) {
    const px = leg > 0 ? p[leg * 2 - 2]! : r.sx, py = leg > 0 ? p[leg * 2 - 1]! : r.sy;
    if (px === px && py === py) { // the incoming leg is known (not NaN)
      const wx = p[leg * 2]!, wy = p[leg * 2 + 1]!;
      const dx = wx - x, dy = wy - y;
      if (dx * dx + dy * dy > arrive * arrive) return leg;
      // Short of the turn along the incoming leg (positive dot with its heading): hold it.
      if (dx * (wx - px) + dy * (wy - py) > 0) return leg;
      r.leg = leg + 1;
      return r.leg;
    }
  }
  r.leg = stepRoute(p, r.count, leg, x, y, arrive, true);
  return r.leg >= r.count ? -1 : r.leg;
}
