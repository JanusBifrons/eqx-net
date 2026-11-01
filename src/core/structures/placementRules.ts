/**
 * Pure structure-placement legality (Phase-4 C2).
 *
 * A new structure's footprint may not overlap an existing structure OR an
 * obstacle (asteroid). Pre-Phase-4 the server only tested existing STRUCTURES,
 * so a Capital dropped on a rock LANDED ("places on an asteroid"). This module
 * is the SINGLE source of that rule — the server consults it on `place_structure`
 * and the client can consult it for the placement ghost — so both agree.
 *
 * Zone-pure (no I/O, reads only the catalogue radius). **Alloc-free** — the
 * reason is a string-literal union (interned, never a fresh object) and the
 * iterables are caller-owned, so it's safe to call from the per-frame ghost
 * preview (invariant #14). `null` means legal.
 */
import { structureHalfExtents } from '../../shared-types/structureKinds.js';
import type { GridObstacle } from './Grid.js';

/** A circular footprint to test against (a placed structure or the ghost). */
export interface PlacementFootprint {
  x: number;
  y: number;
  radius: number;
  /** Footprint half extents (phase V). ABSENT ⇒ a square of `radius`. */
  halfW?: number;
  halfH?: number;
}

/** Why a placement is illegal. `null` (from {@link placementRejection}) = legal. */
export type PlacementRejection = 'overlap-structure' | 'overlap-obstacle';

/** Two axis-aligned boxes (structure footprints, rotations are 90° steps)
 *  overlap when they intersect on BOTH axes. Touching edges are legal. */
function boxesOverlap(ax: number, ay: number, ahw: number, ahh: number, bx: number, by: number, bhw: number, bhh: number): boolean {
  return Math.abs(ax - bx) < ahw + bhw && Math.abs(ay - by) < ahh + bhh;
}

/** A box vs a circle (an asteroid): the circle's centre is closer than its
 *  radius to the box's nearest point. */
function boxOverlapsCircle(bx: number, by: number, hw: number, hh: number, cx: number, cy: number, r: number): boolean {
  const dx = Math.max(Math.abs(cx - bx) - hw, 0);
  const dy = Math.max(Math.abs(cy - by) - hh, 0);
  return dx * dx + dy * dy < r * r;
}

/**
 * The reason a `kindId` footprint at (x, y) cannot be placed, or `null` when it
 * is legal. Tests the sum-of-radii overlap against every `structures` entry and
 * every `obstacles` entry (asteroids). `obstacles` omitted/empty ⇒ structures-only
 * (byte-identical to the legacy server check).
 */
export function placementRejection(
  kindId: string,
  x: number,
  y: number,
  structures: Iterable<PlacementFootprint>,
  obstacles?: readonly GridObstacle[] | null,
  rotDeg: number = 0,
): PlacementRejection | null {
  const { hw, hh } = structureHalfExtents(kindId, rotDeg);
  for (const s of structures) {
    if (boxesOverlap(s.x, s.y, s.halfW ?? s.radius, s.halfH ?? s.radius, x, y, hw, hh)) return 'overlap-structure';
  }
  if (obstacles) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i]!;
      if (boxOverlapsCircle(x, y, hw, hh, o.x, o.y, o.radius)) return 'overlap-obstacle';
    }
  }
  return null;
}

/** Convenience boolean wrapper over {@link placementRejection}. */
export function canPlaceStructureAt(
  kindId: string,
  x: number,
  y: number,
  structures: Iterable<PlacementFootprint>,
  obstacles?: readonly GridObstacle[] | null,
  rotDeg: number = 0,
): boolean {
  return placementRejection(kindId, x, y, structures, obstacles, rotDeg) === null;
}
