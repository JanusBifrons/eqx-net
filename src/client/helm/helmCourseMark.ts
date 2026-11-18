/**
 * Helm move marker: whether the local pilot sees the green course marker,
 * and where. The order lives in `ColyseusClient` (main thread); the marker
 * rides `RenderMirror.helmCourse` to the renderer (spatial ⇒ never Zustand,
 * #2). Shown only for the ship you fly (helm `available`, every hull),
 * only while an order is active, never while spectating. Other players' and
 * NPC ships have no helm order on this client, so they never get a marker.
 *
 * No allocation: the caller owns `out` (#14).
 */
import type { HelmOrder } from '@core/helm/helm';
import { NAV_ROUTE_REPLY_MAX_POINTS } from '@shared-types/messages/navMessages';

export interface HelmCourseMark {
  /** Course point, game space (Y-up). */
  x: number;
  y: number;
  /** Bumps on every new course tap: the renderer replays its "pop". */
  seq: number;
  /** The turns still ahead (game space, packed x, y; the last is the course
   *  point) and how many: the route line (navigation slice 14). 0 = none yet
   *  (the line runs straight to the point). */
  route: Float64Array;
  routeN: number;
}

export function makeHelmCourseMark(): HelmCourseMark {
  return { x: 0, y: 0, seq: 0, route: new Float64Array(NAV_ROUTE_REPLY_MAX_POINTS * 2), routeN: 0 };
}

export function resolveHelmCourseMark(
  order: Readonly<HelmOrder>,
  available: boolean,
  spectating: boolean,
  seq: number,
  out: HelmCourseMark,
): boolean {
  if (!order.active || !available || spectating) return false;
  out.x = order.tx;
  out.y = order.ty;
  out.seq = seq;
  const r = order.route;
  let n = 0;
  if (r != null) for (let i = r.idx; i < r.n && n < NAV_ROUTE_REPLY_MAX_POINTS; i++, n++) { out.route[n * 2] = r.pts[i * 2]!; out.route[n * 2 + 1] = r.pts[i * 2 + 1]!; }
  out.routeN = n;
  return true;
}
