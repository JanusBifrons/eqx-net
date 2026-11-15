/**
 * One AI-flown ship's orders (RTS Part B slice 12): the owner's word for it,
 * as plain data. The shared AI pilot brain (`HostileDroneBehaviour`) flies the
 * hull; the room reads this record and hands each part to that brain
 * (`SectorRoom.applyHullMode` / `applyHullStance` / the fleet hooks).
 *
 *  - MODE: the standing job (defend / patrol / hunt / escort / retreat).
 *  - ORDER: a one-off on top (move / attack / stop). When it is done the mode
 *    resumes from where the ship is (`clearFleetOrder`).
 *  - STANCE: when the ship may open fire.
 *  - The mode's data: the guard post (defend / hunt), the retreat point, the
 *    escort target and the patrol route (packed `x0, y0, x1, y1, ...`,
 *    `stepRoute`'s layout, walked by the ONE route stepper).
 *
 * Squad membership and roles live on the fleet subsystem's entry, not here.
 * Pure, allocation-free except where noted (a rare re-key).
 */
import { stepRoute } from '../../core/ai/stepRoute.js';
import {
  FLEET_ROUTE_MAX,
  FLEET_ROUTE_MIN,
  type FleetMode,
  type FleetOrder,
  type FleetStance,
} from '../../shared-types/messages/fleetStatusMessages.js';
import type { FleetSavedModeData } from './fleetPersistence.js';

/** `set_mode` parameters (the wire message's optional fields):
 *  - `x` / `y`: the defend / hunt post, or the retreat point.
 *  - `route`: patrol waypoints ({@link FLEET_ROUTE_MIN}–{@link FLEET_ROUTE_MAX}).
 *  - `escortId`: the ship escort keeps station on. */
export interface FleetModeData {
  x?: number;
  y?: number;
  route?: readonly (readonly [number, number])[];
  escortId?: string;
}

export interface FleetShipOrders {
  mode: FleetMode;
  stance: FleetStance;
  order: FleetOrder | null;
  /** Defend / Hunt post; null ⇒ where the hull is now. */
  guardPostX: number | null;
  guardPostY: number | null;
  /** Retreat point; null ⇒ the post. */
  retreatPointX: number | null;
  retreatPointY: number | null;
  /** Escort: the ship kept company (a shipInstanceId), or null. */
  escortId: string | null;
  /** Patrol route, packed x0, y0, x1, y1, ... (`routeLen` points). */
  readonly route: Float64Array;
  routeLen: number;
  /** Patrol: the waypoint being flown to. */
  routeIdx: number;
  /** True ⇒ the next step heads for the waypoint nearest the ship. */
  routeSeek: boolean;
  /** Patrol: a waypoint counts as passed inside this (u, the hull's size, #18). */
  readonly passRadius: number;
}

/** A fresh record: Defend at (x, y), Defensive stance, no order. */
export function makeFleetShipOrders(passRadius: number, x: number, y: number): FleetShipOrders {
  return {
    mode: 'defend',
    stance: 'defensive',
    order: null,
    guardPostX: x,
    guardPostY: y,
    retreatPointX: null,
    retreatPointY: null,
    escortId: null,
    route: new Float64Array(FLEET_ROUTE_MAX * 2),
    routeLen: 0,
    routeIdx: 0,
    routeSeek: true,
    passRadius,
  };
}

/**
 * Change the standing mode (a direct order in hand stays).
 *  - defend / hunt: post at (x, y), else where the hull is.
 *  - patrol: 2–16 waypoints (extra dropped); fewer ⇒ defend at the single
 *    waypoint, else at (x, y), else where the hull is.
 *  - escort: no `escortId` ⇒ defend where the hull is.
 *  - retreat: to (x, y), else to the post.
 */
export function setFleetMode(o: FleetShipOrders, mode: FleetMode, data?: FleetModeData): void {
  const px = data?.x, py = data?.y;
  const hasPoint = px !== undefined && py !== undefined;
  o.mode = mode;
  o.escortId = null;
  o.routeLen = 0;
  o.retreatPointX = null;
  o.retreatPointY = null;
  switch (mode) {
    case 'patrol': {
      const r = data?.route;
      const n = r !== undefined ? Math.min(r.length, FLEET_ROUTE_MAX) : 0;
      if (n >= FLEET_ROUTE_MIN) {
        for (let i = 0; i < n; i++) { o.route[i * 2] = r![i]![0]; o.route[i * 2 + 1] = r![i]![1]; }
        o.routeLen = n;
        o.routeIdx = 0;
        o.routeSeek = true;
        setPost(o, null, null);
        return;
      }
      o.mode = 'defend';
      if (n === 1) setPost(o, r![0]![0], r![0]![1]);
      else if (hasPoint) setPost(o, px, py);
      else setPost(o, null, null);
      return;
    }
    case 'escort':
      if (data?.escortId !== undefined && data.escortId !== '') o.escortId = data.escortId;
      else o.mode = 'defend';
      setPost(o, null, null);
      return;
    case 'retreat':
      if (hasPoint) { o.retreatPointX = px; o.retreatPointY = py; }
      return;
    case 'defend':
    case 'hunt':
      if (hasPoint) setPost(o, px, py);
      else setPost(o, null, null);
      return;
  }
}

/** Defend the point (x, y) (a finished Stop or Retreat). */
export function defendAt(o: FleetShipOrders, x: number, y: number): void {
  setFleetMode(o, 'defend');
  setPost(o, x, y);
}

/** The order is done (or dropped): the mode resumes from where the ship is
 *  now (defend / hunt take that spot as the post, patrol the nearest waypoint). */
export function clearFleetOrder(o: FleetShipOrders): void {
  o.order = null;
  setPost(o, null, null);
  o.routeSeek = true;
}

/**
 * Patrol: step the route for a ship at (x, y) and return the waypoint to fly
 * to (-1 with no route). After a resume it starts from the waypoint nearest
 * the ship; else it moves on once within the pass radius (`stepRoute`, shared
 * with the garrison patrols), looping.
 */
export function stepFleetPatrol(o: FleetShipOrders, x: number, y: number): number {
  const n = o.routeLen;
  if (n < FLEET_ROUTE_MIN) return -1;
  if (o.routeSeek) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = o.route[i * 2]! - x, dy = o.route[i * 2 + 1]! - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    o.routeIdx = best;
    o.routeSeek = false;
  }
  o.routeIdx = stepRoute(o.route, n, o.routeIdx, x, y, o.passRadius);
  return o.routeIdx;
}

/** The ship an attack order names, or null. */
export function fleetOrderTarget(o: FleetShipOrders): string | null {
  return o.order !== null && o.order.kind === 'attack' ? o.order.targetId : null;
}

/** A ship this record names changed key (playerId <-> shipInstanceId): an
 *  attack order follows it. Escort ids are always shipInstanceIds, so they
 *  never move. Rare (a hand-over), never per tick. */
export function fleetOrderKeyMoved(o: FleetShipOrders, from: string, to: string): void {
  if (fleetOrderTarget(o) === from) o.order = { kind: 'attack', targetId: to };
}

/** The data of the current mode (persistence), or null when it has none. */
export function savedModeDataOf(o: FleetShipOrders): FleetSavedModeData | null {
  switch (o.mode) {
    case 'patrol': {
      const n = o.routeLen;
      if (n < FLEET_ROUTE_MIN) return null;
      const route: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) route.push([o.route[i * 2]!, o.route[i * 2 + 1]!]);
      return { route };
    }
    case 'escort':
      return o.escortId !== null ? { escortId: o.escortId } : null;
    case 'retreat':
      return o.retreatPointX !== null ? { x: o.retreatPointX, y: o.retreatPointY! } : null;
    case 'defend':
    case 'hunt':
      return o.guardPostX !== null ? { x: o.guardPostX, y: o.guardPostY! } : null;
  }
}

function setPost(o: FleetShipOrders, x: number | null, y: number | null): void {
  o.guardPostX = x;
  o.guardPostY = y;
}
