/**
 * "Pick on the map" for the fleet modes that need a target (RTS slice 14b).
 *
 *  - patrol: each tap adds a waypoint (up to {@link FLEET_PICK_ROUTE_MAX});
 *    Done (button / Enter / mouse right-click) sends the route once it has
 *    {@link FLEET_PICK_ROUTE_MIN} points.
 *  - escort: the next tap on one of your own ships that is NOT being
 *    commanded picks the ship to escort; a tap anywhere else does nothing.
 *  - retreat: the next tap is the retreat point. The panel's "Back to post"
 *    sends retreat with no point (the server then retreats to the post).
 *
 * The points are spatial, so they live here in the renderer (worker-safe,
 * pure, no Pixi); only the kind and the point COUNT reach Zustand. The state
 * object is reused: no allocation per tap except the result on finish.
 */
import { WINGMAN_ROUTE_MAX, WINGMAN_ROUTE_MIN } from '@core/ai/wingman/types';

export type FleetPickKind = 'patrol' | 'escort' | 'retreat';

export const FLEET_PICK_ROUTE_MIN = WINGMAN_ROUTE_MIN;
export const FLEET_PICK_ROUTE_MAX = WINGMAN_ROUTE_MAX;

export interface FleetPickState {
  kind: FleetPickKind | null;
  /** Patrol waypoints, game space, flat `[x0, y0, x1, y1, ...]` (fixed size). */
  readonly route: Float64Array;
  /** Waypoints in use. */
  count: number;
}

/** What a finished pick sends with `set_mode`. Allocated once per finish. */
export type FleetPickResult =
  | { kind: 'patrol'; route: [number, number][] }
  | { kind: 'escort'; escortId: string }
  | { kind: 'retreat'; x?: number; y?: number };

export function createFleetPickState(): FleetPickState {
  return { kind: null, route: new Float64Array(FLEET_PICK_ROUTE_MAX * 2), count: 0 };
}

/** Start (or, with null, cancel) a pick. Always drops any points. */
export function pickStart(s: FleetPickState, kind: FleetPickKind | null): void {
  s.kind = kind;
  s.count = 0;
}

/** Add a patrol waypoint. False when not picking a patrol or at the cap. */
export function pickAddPoint(s: FleetPickState, x: number, y: number): boolean {
  if (s.kind !== 'patrol' || s.count >= FLEET_PICK_ROUTE_MAX) return false;
  s.route[s.count * 2] = x;
  s.route[s.count * 2 + 1] = y;
  s.count++;
  return true;
}

/** Done is allowed: a patrol with enough points. */
export function pickCanFinish(s: FleetPickState): boolean {
  return s.kind === 'patrol' && s.count >= FLEET_PICK_ROUTE_MIN;
}

/** Finish a patrol pick: the route, then the state is cleared. Null (and
 *  the state kept) when Done is not allowed yet. */
export function pickFinishPatrol(s: FleetPickState): FleetPickResult | null {
  if (!pickCanFinish(s)) return null;
  const route: [number, number][] = [];
  for (let i = 0; i < s.count; i++) route.push([s.route[i * 2]!, s.route[i * 2 + 1]!]);
  pickStart(s, null);
  return { kind: 'patrol', route };
}

/** What a map tap means while picking. */
export type PickTapAction = 'addPoint' | 'retreatHere' | 'escortShip' | 'ignore';

/**
 * Decide a tap while picking. `hitOwnId` is the own ship under the tap (or
 * null); `hitSelected` whether that ship is one being commanded.
 */
export function decidePickTap(
  kind: FleetPickKind | null,
  hitOwnId: string | null,
  hitSelected: boolean,
  count: number,
): PickTapAction {
  switch (kind) {
    case 'patrol':
      return count < FLEET_PICK_ROUTE_MAX ? 'addPoint' : 'ignore';
    case 'retreat':
      return 'retreatHere';
    case 'escort':
      // A ship cannot escort itself: only an own ship outside the selection.
      return hitOwnId !== null && !hitSelected ? 'escortShip' : 'ignore';
    default:
      return 'ignore';
  }
}
