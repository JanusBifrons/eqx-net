/**
 * Warp route check, slice S1: the warp TARGET a destination really offers.
 *
 * Owner rule: a warp never runs part way and stops. When the line from the
 * ship to a destination's rim point is blocked (the field's rock body or a
 * structure's footprint, `warpLineStop`), the destination's target IS the
 * near side of the obstacle, and the warp menu shows that point; the server
 * accepts only targets whose line is clear (`isWarpTarget`).
 *
 * The structure footprint the client and server adapters feed in comes from
 * the one function here (`fillWarpStructureFootprint`), so both sides test
 * the same boxes by construction (invariant #15).
 *
 * Pure and allocation-free (invariant #14): module scratch only.
 */
import type { ShipKind } from '../../shared-types/shipKinds/types.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { structureHalfExtentsInto } from '../../shared-types/structureKinds/geometry.js';
import type { CoarseFieldMap } from '../nav/coarseField.js';
import {
  newWarpLineStop, warpLineClear, warpLineStop,
  type WarpLineStop, type WarpStructureFootprint, type WarpStructureSource,
} from '../nav/warpLineStop.js';
import { WARP_DROP_TOLERANCE } from './sectorSites.js';

/** Shortest warp worth offering (world u): a near-side stop closer to the
 *  ship than this is "not reachable" (fly there instead). Well past the drop
 *  tolerance and several one-tick cruise runs (`WARP_SPEED / 60` ≈ 333 u). */
export const WARP_MIN_DISTANCE = 1000;

/** How far short of an obstacle a hull's warp stops (world u): at least its
 *  spawn clearance, and never less than its nav clearance (hull centre to
 *  rock), so the ship drops out clear of what stopped it. Per kind (#18). */
export function warpStopMargin(kind: ShipKind): number {
  const t = shipTuning(kind);
  return Math.max(t.spawnClearance, t.navClearance);
}

/** A destination's warp target (`warpTargetFor`). */
export interface WarpTarget extends WarpLineStop {
  /** False when the target is closer to the ship than `WARP_MIN_DISTANCE`:
   *  the menu offers no warp to this destination. */
  reachable: boolean;
}

export function newWarpTarget(): WarpTarget {
  return { x: 0, y: 0, blocked: false, shortBy: 0, reachable: false };
}

/**
 * The warp target for a destination whose rim point is (rimX, rimY), from a
 * ship at (px, py): the rim point when the line is clear, else the near side
 * of the first obstacle, `margin` short (`warpStopMargin`). `shortBy` is how
 * far short of the rim point it is. Writes and returns `out`.
 */
export function warpTargetFor(
  rimX: number, rimY: number,
  px: number, py: number,
  field: CoarseFieldMap | null,
  structures: WarpStructureSource | null,
  margin: number,
  out: WarpTarget,
): WarpTarget {
  warpLineStop(field, structures, px, py, rimX, rimY, margin, out);
  out.reachable = Math.hypot(out.x - px, out.y - py) >= WARP_MIN_DISTANCE;
  return out;
}

const stopScratch = newWarpLineStop();

/**
 * The server's acceptance test for a requested warp target (tx, ty) toward a
 * destination whose rim point is (rimX, rimY), from a ship at (px, py). The
 * line to the target must be clear, and the target must be either the rim
 * point or the near-side stop on the line to it (each within
 * `WARP_DROP_TOLERANCE`), so no warp ends at an arbitrary point short of the
 * destination.
 */
export function isWarpTarget(
  px: number, py: number,
  tx: number, ty: number,
  rimX: number, rimY: number,
  field: CoarseFieldMap | null,
  structures: WarpStructureSource | null,
  margin: number,
): boolean {
  if (!warpLineClear(field, structures, px, py, tx, ty)) return false;
  if (Math.hypot(tx - rimX, ty - rimY) <= WARP_DROP_TOLERANCE) return true;
  if (segmentDistance(tx, ty, px, py, rimX, rimY) > WARP_DROP_TOLERANCE) return false;
  const stop = warpLineStop(field, structures, px, py, rimX, rimY, margin, stopScratch);
  return stop.blocked && Math.hypot(tx - stop.x, ty - stop.y) <= WARP_DROP_TOLERANCE;
}

/** Distance from (x, y) to the segment (ax, ay)→(bx, by). */
function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

const ext = { hw: 0, hh: 0 };

/**
 * A structure's warp footprint, the ONE fill both the server and client
 * structure sources use (#15): centre (x, y), the kind's box at its quarter
 * turn `rotationDeg` (`structureHalfExtents`), and a gate's world-axis part
 * boxes (`gateBoxes`, as on its swarm record; null for any other kind).
 * Writes and returns `out`.
 */
export function fillWarpStructureFootprint(
  kind: string | null | undefined,
  x: number, y: number,
  rotationDeg: number | null | undefined,
  gateBoxes: Float32Array | null | undefined,
  out: WarpStructureFootprint,
): WarpStructureFootprint {
  // TODO(bp-16): oriented box — axis-aligned at an odd-30° turn.
  structureHalfExtentsInto(kind, rotationDeg, ext);
  out.x = x; out.y = y;
  out.halfW = ext.hw; out.halfH = ext.hh;
  out.boxes = gateBoxes ?? undefined;
  return out;
}
