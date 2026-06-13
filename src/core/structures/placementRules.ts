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
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { GridObstacle } from './Grid.js';

/** A circular footprint to test against (a placed structure or the ghost). */
export interface PlacementFootprint {
  x: number;
  y: number;
  radius: number;
}

/** Why a placement is illegal. `null` (from {@link placementRejection}) = legal. */
export type PlacementRejection = 'overlap-structure' | 'overlap-obstacle';

/** Sum-of-radii circle overlap (centre distance < r₁ + r₂). The exact semantics
 *  the server's pre-existing structure-overlap loop used, factored out so the
 *  obstacle pass reuses it. */
function overlaps(ax: number, ay: number, ar: number, bx: number, by: number, br: number): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const minDist = ar + br;
  return dx * dx + dy * dy < minDist * minDist;
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
): PlacementRejection | null {
  const radius = getStructureKind(kindId).radius;
  for (const s of structures) {
    if (overlaps(s.x, s.y, s.radius, x, y, radius)) return 'overlap-structure';
  }
  if (obstacles) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i]!;
      if (overlaps(o.x, o.y, o.radius, x, y, radius)) return 'overlap-obstacle';
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
): boolean {
  return placementRejection(kindId, x, y, structures, obstacles) === null;
}
