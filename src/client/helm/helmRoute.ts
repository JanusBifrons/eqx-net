/**
 * Autopilot routes for the helm (navigation slice 13).
 *
 * A course tap asks the server for a way there (`nav_route_request`); until
 * the reply comes the helm flies straight at the point, as it always did.
 * The reply (`nav_route`) loads its waypoints into the helm order's route, and
 * the helm passes through them (`core/helm/helm.ts`). `nearest` moves the
 * order's point to where the route ends (no way fits: get as close as the ship
 * can and wait there); `none` (nowhere nearer) tells the caller to end the order.
 *
 * Client-local: nobody else sees the route (it is advice for this client's own
 * inputs). The client keeps the server's rate (one request in flight, one per
 * `NAV_ROUTE_MIN_GAP_MS` of game time): a newer tap waits for the gap, so the
 * server never has to drop it; a reply for an older tap is ignored. A reply
 * that never comes is given up after `NAV_ROUTE_LOST_MS` and asked again.
 */
import type { HelmOrder, HelmRoute } from '@core/helm/helm';
import {
  NAV_ROUTE_MIN_GAP_MS, NAV_ROUTE_REPLY_MAX_POINTS, NavRouteReplySchema, type NavRouteRequest,
} from '../../shared-types/messages/navMessages.js';

/** Game ms after which an unanswered request counts as lost. */
export const NAV_ROUTE_LOST_MS = 5000;

export type HelmRouteSend = (type: 'nav_route_request', msg: NavRouteRequest) => void;

export class HelmRouteClient {
  /** The route the helm flies (handed to the order once a reply lands). */
  readonly route: HelmRoute = { pts: new Float64Array(NAV_ROUTE_REPLY_MAX_POINTS * 2), n: 0, idx: 0 };
  /** The newest course still waiting to be asked (-1: none). */
  private wantId = -1;
  private wantX = 0;
  private wantY = 0;
  private nextId = 0;
  private inFlightId = -1;
  private sentAt = -Infinity;
  /** Reused request (sent at most twice a second). */
  private readonly msg: NavRouteRequest = { type: 'nav_route_request', reqId: 0, tx: 0, ty: 0 };

  constructor(private readonly send: HelmRouteSend) {}

  /** A new course point: fly straight for now; ask for a way at the next allowed moment. */
  course(order: HelmOrder, nowMs: number): void {
    order.route = null;
    this.nextId = (this.nextId + 1) & 0x7fffffff;
    this.wantId = this.nextId;
    this.wantX = order.tx;
    this.wantY = order.ty;
    this.tick(nowMs);
  }

  /** The course was cancelled: stop asking, ignore late replies. */
  clear(): void { this.wantId = -1; this.inFlightId = -1; }

  /** Each input tick (game ms): send the waiting ask once the gap allows. */
  tick(nowMs: number): void {
    if (this.inFlightId >= 0 && nowMs - this.sentAt > NAV_ROUTE_LOST_MS) this.inFlightId = -1; // lost
    if (this.wantId < 0 || this.inFlightId >= 0 || nowMs - this.sentAt < NAV_ROUTE_MIN_GAP_MS) return;
    this.msg.reqId = this.wantId;
    this.msg.tx = this.wantX;
    this.msg.ty = this.wantY;
    this.inFlightId = this.wantId;
    this.sentAt = nowMs;
    this.wantId = -1;
    this.send('nav_route_request', this.msg);
  }

  /** `nav_route` reply: `route` when it loaded a route into the order (the
   *  caller republishes), `end` when the caller should end the order, else `keep`. */
  onReply(raw: unknown, order: HelmOrder): 'route' | 'end' | 'keep' {
    const p = NavRouteReplySchema.safeParse(raw);
    if (!p.success || p.data.reqId !== this.inFlightId) return 'keep';
    this.inFlightId = -1;
    // A newer tap is waiting, or the order was cancelled: this route is stale.
    if (this.wantId >= 0 || !order.active) return 'keep';
    const { status, points } = p.data;
    if (status === 'none') return 'end';
    const n = Math.min(points.length >> 1, NAV_ROUTE_REPLY_MAX_POINTS);
    if (status === 'straight' || n === 0) { order.route = null; return 'keep'; }
    const r = this.route;
    for (let i = 0; i < n * 2; i++) r.pts[i] = points[i]!;
    r.n = n;
    r.idx = 0;
    order.tx = r.pts[n * 2 - 2]!;
    order.ty = r.pts[n * 2 - 1]!;
    order.route = r;
    return 'route';
  }
}
