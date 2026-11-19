/**
 * Navigation slice 12: answers a player's autopilot route request
 * (`nav_route_request`, `shared-types/messages/navMessages.ts`).
 *
 * The room hands over the asker's own active hull (pose + kind, read
 * server-side: the client names only the goal). The route is planned on the
 * room's nav field with the hull's own clearance (`shipTuning`, #18) and, for
 * a capital, its nose and turning radius (slice 11, the same as AI capitals).
 * No field (open space) answers `straight` at once.
 *
 * Per player: one request in flight and at most one per
 * `NAV_ROUTE_MIN_GAP_MS` of game time; over-rate requests are dropped
 * silently (as inputs and lock messages are). The reply goes to the asker only.
 */
import type { NavRouteMsg } from '../../core/nav/navHost.js';
import { makePilotHandling, pilotTurnRadius } from '../../core/ai/virtualPilot.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipBodyMass, shipTuning } from '../../shared-types/shipScale/tuning.js';
import { NAV_ROUTE_MIN_GAP_MS, type NavRouteReply } from '../../shared-types/messages/navMessages.js';

/** Plans a route (the room's `NavField.route`), or null when the room has no field. */
export type AutopilotRouteFn = ((sx: number, sy: number, tx: number, ty: number, clearance: number, heading: number, turnRadius: number) => Promise<NavRouteMsg>) | null;

/** The asker's hull, as the room reads it. */
export interface AutopilotHull { x: number; y: number; angle: number; kind: string }

interface Asker { inFlight: boolean; lastAt: number }

export class AutopilotRoutes {
  private readonly askers = new Map<string, Asker>();
  /** Turning radius per kind id (worked out once). */
  private readonly turnRadii = new Map<string, number>();
  /** Requests answered / dropped over the rate (diagnostics, tests). */
  answered = 0;
  dropped = 0;

  constructor(private readonly route: () => AutopilotRouteFn, private readonly now: () => number) {}

  /** Handle one parsed request. `send` gets the reply (asker only). */
  request(playerId: string, hull: AutopilotHull, reqId: number, tx: number, ty: number, send: (r: NavRouteReply) => void): void {
    const now = this.now();
    let a = this.askers.get(playerId);
    if (a === undefined) { a = { inFlight: false, lastAt: -Infinity }; this.askers.set(playerId, a); }
    if (a.inFlight || now - a.lastAt < NAV_ROUTE_MIN_GAP_MS) { this.dropped++; return; }
    a.lastAt = now;
    const fn = this.route();
    if (fn === null) {
      this.answered++;
      send({ type: 'nav_route', reqId, status: 'straight', points: [] });
      return;
    }
    const kind = getShipKind(hull.kind);
    const capital = kind.sizeClass === 'capital';
    a.inFlight = true;
    const asker = a;
    fn(hull.x, hull.y, tx, ty, shipTuning(kind).navClearance, capital ? hull.angle : NaN, capital ? this.turnRadius(hull.kind) : 0).then((msg) => {
      asker.inFlight = false;
      this.answered++;
      send({ type: 'nav_route', reqId, status: msg.status, points: Array.from(msg.points) });
    }, () => { asker.inFlight = false; });
  }

  /** Forget a player (left the room). */
  forget(playerId: string): void { this.askers.delete(playerId); }

  private turnRadius(kindId: string): number {
    let r = this.turnRadii.get(kindId);
    if (r === undefined) {
      const kind = getShipKind(kindId);
      r = pilotTurnRadius(makePilotHandling(kind, shipBodyMass(kind)));
      this.turnRadii.set(kindId, r);
    }
    return r;
  }
}
