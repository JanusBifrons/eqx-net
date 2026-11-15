/**
 * The ONE patrol-route stepper (RTS Part B slice 11). A route is a closed loop
 * of waypoints, packed flat (`x0, y0, x1, y1, ...`). A ship flying to
 * waypoint `leg` that is within `arrive` of it moves on to the next one,
 * looping last → first.
 *
 * Shared by the garrison patrols (`PatrolSubsystem`) and an owned ship's fleet
 * Patrol mode (the route its fleet orders keep, `server/fleet/fleetShipOrders`). Pure,
 * allocation-free.
 *
 * @returns the waypoint index to fly to now (`leg`, or the next one).
 */
export function stepRoute(
  points: ArrayLike<number>,
  count: number,
  leg: number,
  x: number,
  y: number,
  arrive: number,
): number {
  if (count <= 0) return 0;
  const dx = points[leg * 2]! - x;
  const dy = points[leg * 2 + 1]! - y;
  return dx * dx + dy * dy <= arrive * arrive ? (leg + 1) % count : leg;
}
