/**
 * The sandbox ship grid (docs/features/sandbox.md): when a pilot joins a room
 * with `ownedFleet` (sealed rooms only), ONE of every base pilot hull
 * (`BASE_PILOT_HULL_KINDS_LIST`: fit variants folded away) waits parked in a
 * tidy grid beside the spawn, owned by them, ready to take over
 * (`pilot_ship`). Each hull comes through the one new-hull path,
 * `HullHandOff.launchNewHull` (roster row + lingering hull, defensive).
 *
 * Re-join: a kind the pilot already has alive in the room (flown or parked)
 * is skipped; a destroyed or missing one is replaced, so there are never
 * duplicates. Each pilot gets their own lane of the grid (lanes stack south),
 * so several joiners' grids never overlap.
 *
 * Join-time only (allocation is fine here; never on a tick).
 */
import { BASE_PILOT_HULL_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { sizeClassOf } from '../../shared-types/shipScale/tuning.js';
import { hullExtent } from './join/joinConstants.js';
import type { NewHullOrigin, NewHullResult } from './features/hullHandOff.js';

/** One hull to place: its kind, clearance extent and size group. */
export interface FleetHull { kind: string; extent: number; capital: boolean }
/** One placed hull: its park point. */
export interface FleetSlot { kind: string; x: number; y: number }

/** Edge-to-edge gap between neighbouring hulls, and between rows. */
export const FLEET_HULL_GAP = 300;
/** Extra gap between two pilots' lanes. */
export const FLEET_LANE_GAP = 1500;

/**
 * The grid, pure. Two rows per lane: sub-capitals, then capitals (each row
 * smallest first). Rows run WEST from the anchor (the room's spawn point; the
 * sandbox build site is east of it), starting one largest-hull extent plus a
 * gap clear of it, so even a capital spawning on the anchor never touches the
 * grid. Cells are sized by each hull's own extent (#18). Lane `k` sits `k`
 * lane heights south of lane 0, whose first row is level with the anchor.
 */
export function fleetGridLayout(hulls: readonly FleetHull[], anchorX: number, anchorY: number, lane: number): FleetSlot[] {
  const rows = [hulls.filter((h) => !h.capital), hulls.filter((h) => h.capital)]
    .filter((r) => r.length > 0)
    .map((r) => [...r].sort((a, b) => a.extent - b.extent));
  let maxExtent = 0;
  for (const h of hulls) maxExtent = Math.max(maxExtent, h.extent);
  const rowHalf = rows.map((r) => r[r.length - 1]!.extent);
  let laneHeight = FLEET_LANE_GAP;
  for (const half of rowHalf) laneHeight += 2 * half + FLEET_HULL_GAP;
  const startX = anchorX - maxExtent - FLEET_HULL_GAP;
  const out: FleetSlot[] = [];
  let rowY = anchorY - lane * laneHeight;
  rows.forEach((row, i) => {
    if (i > 0) rowY -= rowHalf[i - 1]! + FLEET_HULL_GAP + rowHalf[i]!;
    let edge = startX;
    for (const h of row) {
      out.push({ kind: h.kind, x: edge - h.extent, y: rowY });
      edge -= 2 * h.extent + FLEET_HULL_GAP;
    }
  });
  return out;
}

/** The base pilot hulls with their extents (built once, on first use). */
let fleetHulls: readonly FleetHull[] | null = null;
export function baseFleetHulls(): readonly FleetHull[] {
  fleetHulls ??= BASE_PILOT_HULL_KINDS_LIST.map((k) => ({
    kind: k.id, extent: hullExtent(k.id), capital: sizeClassOf(k) === 'capital',
  }));
  return fleetHulls;
}

/** What the seeder needs from the room (the join deps satisfy it). */
export interface FleetSeedHost {
  /** The room has the `ownedFleet` option (sealed rooms only). */
  readonly ownedFleet: boolean;
  readonly defaultSpawnX: number | null;
  readonly defaultSpawnY: number | null;
  readonly shipsMap: { values(): Iterable<{ playerId: string; kind: string; alive: boolean }> };
  /** `HullHandOff.launchNewHull(playerId, kind, quality, o, requireLive=true)`. */
  launchFleetHull(playerId: string, kind: string, o: NewHullOrigin): NewHullResult;
}

/** Each room's pilot → lane (keyed by the room's host object). */
const lanesByRoom = new WeakMap<object, Map<string, number>>();

/**
 * Park the pilot's missing base hulls in their lane. `spawnX/Y` anchors the
 * grid when the room has no fixed spawn point. Returns how many were made.
 */
export function seedOwnedFleet(host: FleetSeedHost, playerId: string, spawnX: number, spawnY: number): number {
  if (!host.ownedFleet) return 0;
  const have = new Set<string>();
  for (const s of host.shipsMap.values()) if (s.alive && s.playerId === playerId) have.add(s.kind);
  let lanes = lanesByRoom.get(host);
  if (lanes === undefined) lanesByRoom.set(host, (lanes = new Map()));
  let lane = lanes.get(playerId);
  if (lane === undefined) lanes.set(playerId, (lane = lanes.size));
  const slots = fleetGridLayout(baseFleetHulls(), host.defaultSpawnX ?? spawnX, host.defaultSpawnY ?? spawnY, lane);
  let made = 0;
  for (const s of slots) {
    if (have.has(s.kind)) continue;
    const r = host.launchFleetHull(playerId, s.kind, { x: s.x, y: s.y, angle: 0, parkX: s.x, parkY: s.y, flyOut: false });
    if (r.ok) made++;
    else if (r.reason === 'no_slot' || r.reason === 'roster_full') break;
  }
  return made;
}
