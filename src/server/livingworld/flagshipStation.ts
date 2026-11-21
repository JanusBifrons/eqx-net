/**
 * Where a flagship fleet parks and wanders inside a pocket, clear of
 * structures (bug 2026-11-21: a power's battleship parked on its own outer
 * base pocket's centre, where the garrison grows, and ground its hull through
 * the base's connectors and turrets until it died of its own rams).
 *
 * The fleet's footprint is the flagship's spawn clearance or, wider, an
 * escort's station (`escortRing`) plus that escort's spawn clearance: sizes
 * from `tuningFor` (#18), never a constant. Clear points come from the room's
 * one structure query (`LivingWorldRoom.clearPointNear`, `SectorObstacles`
 * + `nearestClearPoint`); no avoidance of its own.
 *
 * Moves are kept clear too: a station or wander point is reached along a
 * straight leg from a clear point, walked in steps of at most half the
 * clearance and cut short at the first blocked step. A hull centre on a leg
 * between two clear steps is then at least √(c² − (c/4)²) ≈ 0.97 c from any
 * structure, still more than its radius (c ≥ 2 × radius). Discrete (a spawn,
 * a warp, a wander pick), never per tick.
 */
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import { tuningFor } from '../../shared-types/shipScale/lookup.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';

type ClearRoom = Pick<LivingWorldRoom, 'clearPointNear'>;

/** How far a fleet's centre (the flagship) keeps from any structure (u). */
export function fleetClearance(capital: ShipKindId, escorts: readonly { kind: ShipKindId }[], ring: (c: ShipKindId, e: ShipKindId) => number): number {
  let c = tuningFor(capital).spawnClearance;
  for (const e of escorts) c = Math.max(c, ring(capital, e.kind) + tuningFor(e.kind).spawnClearance);
  return c;
}

/** True when a hull of `clearance` at (x, y) overlaps no structure. A room
 *  with no structure query (a test fake) is all open. */
function isClear(room: ClearRoom, x: number, y: number, clearance: number): boolean {
  if (!room.clearPointNear) return true;
  const p = room.clearPointNear(x, y, clearance);
  return p.x === x && p.y === y;
}

/** The nearest point to (x, y) clear for `clearance` (unchanged without a
 *  structure query). */
export function clearSpot(room: ClearRoom, x: number, y: number, clearance: number): { x: number; y: number } {
  return room.clearPointNear ? room.clearPointNear(x, y, clearance) : { x, y };
}

/** The furthest point from (fx, fy) toward (tx, ty) whose whole leg is clear
 *  for `clearance` (from a clear start). (fx, fy) itself when the first
 *  step is blocked. */
export function clearReach(room: ClearRoom, fx: number, fy: number, tx: number, ty: number, clearance: number): { x: number; y: number } {
  const dx = tx - fx, dy = ty - fy, len = Math.hypot(dx, dy);
  if (len < 1e-6 || !room.clearPointNear) return { x: tx, y: ty };
  const steps = Math.max(1, Math.ceil(len / (clearance / 2)));
  let bx = fx, by = fy;
  for (let i = 1; i <= steps; i++) {
    const x = fx + (dx * i) / steps, y = fy + (dy * i) / steps;
    if (!isClear(room, x, y, clearance)) break;
    bx = x; by = y;
  }
  return { x: bx, y: by };
}

/** A fleet's station in a pocket: from where it arrives (`ax`, `ay`, made
 *  clear first) in toward the pocket's centre, as far as stays clear. An
 *  empty pocket gives its centre, as before. */
export function pocketStation(room: ClearRoom, site: { x: number; y: number }, ax: number, ay: number, clearance: number): { x: number; y: number } {
  const a = clearSpot(room, ax, ay, clearance);
  return clearReach(room, a.x, a.y, site.x, site.y, clearance);
}
