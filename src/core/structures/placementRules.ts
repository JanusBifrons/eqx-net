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
import { getStructureKind, isStructureKindId, normaliseStructureRotation, structureHalfExtents } from '../../shared-types/structureKinds.js';
import type { GridObstacle } from './Grid.js';

/** A circular footprint to test against (a placed structure or the ghost). */
export interface PlacementFootprint {
  x: number;
  y: number;
  radius: number;
  /** Footprint half extents (phase V). ABSENT ⇒ a square of `radius`. */
  halfW?: number;
  halfH?: number;
  /** Its kind and rotation (degrees). Present ⇒ its kind's `keepClear` box
   *  (a dock's landing pad) is reserved too. ABSENT ⇒ the footprint only. */
  kind?: string;
  rot?: number;
}

/** Why a placement is illegal. `null` (from {@link placementRejection}) = legal. */
export type PlacementRejection = 'overlap-structure' | 'overlap-obstacle' | 'overlap-pad';

/** Plain player-facing text for each rejection. */
export const PLACEMENT_REJECTION_TEXT: Readonly<Record<PlacementRejection, string>> = Object.freeze({
  'overlap-structure': 'Too close to another structure',
  'overlap-obstacle': 'Blocked by an asteroid',
  'overlap-pad': "Keep the dock's landing pad clear",
});

/** Scratch for {@link keepClearBox} (alloc-free: the ghost preview calls this per frame). */
const padBox = { x: 0, y: 0, hw: 0, hh: 0 };

/** The world box of a kind's `keepClear` area (a dock's landing pad) for a
 *  structure at (x, y) turned `rotDeg` (90° steps, game space y-up, CCW), or
 *  `null` when the kind reserves nothing. Returns shared scratch: read it
 *  before the next call. */
export function keepClearBox(kindId: string | undefined, x: number, y: number, rotDeg: number | undefined): { readonly x: number; readonly y: number; readonly hw: number; readonly hh: number } | null {
  if (kindId === undefined || !isStructureKindId(kindId)) return null;
  const kc = getStructureKind(kindId).keepClear;
  if (kc === undefined) return null;
  const r = normaliseStructureRotation(rotDeg);
  const cos = r === 0 ? 1 : r === 180 ? -1 : 0, sin = r === 90 ? 1 : r === 270 ? -1 : 0;
  padBox.x = x + kc.cx * cos - kc.cy * sin;
  padBox.y = y + kc.cx * sin + kc.cy * cos;
  padBox.hw = (sin === 0 ? kc.w : kc.h) / 2;
  padBox.hh = (sin === 0 ? kc.h : kc.w) / 2;
  return padBox;
}

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

/** Does the axis-aligned box (bx, by, ±hw, ±hh) overlap a convex polygon
 *  given relative to (ox, oy) and turned by (cos, sin)? Separating-axis test
 *  on the box's two axes and every polygon edge normal; touching is legal (as
 *  for boxes). A non-convex outline tests as at least its convex hull (its
 *  projections are the hull's), so it can only refuse more, never less.
 *  Allocation-free. */
function boxOverlapsPolygon(
  bx: number, by: number, hw: number, hh: number,
  poly: ReadonlyArray<{ readonly x: number; readonly y: number }>, ox: number, oy: number, cos: number, sin: number,
): boolean {
  const n = poly.length;
  if (n < 3) return false;
  // Box axes: the polygon's world extent along x and y.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = poly[i]!;
    const wx = ox + v.x * cos - v.y * sin, wy = oy + v.x * sin + v.y * cos;
    x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
  }
  if (x0 >= bx + hw || x1 <= bx - hw || y0 >= by + hh || y1 <= by - hh) return false;
  // Polygon edge normals (world frame; unnormalised: both intervals scale alike).
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[i + 1 < n ? i + 1 : 0]!;
    const lx = b.x - a.x, ly = b.y - a.y;
    const ax = -(lx * sin + ly * cos), ay = lx * cos - ly * sin;
    let p0 = Infinity, p1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const v = poly[k]!;
      const d = (ox + v.x * cos - v.y * sin) * ax + (oy + v.x * sin + v.y * cos) * ay;
      p0 = Math.min(p0, d); p1 = Math.max(p1, d);
    }
    const c = bx * ax + by * ay, r = hw * Math.abs(ax) + hh * Math.abs(ay);
    if (p0 >= c + r || p1 <= c - r) return false;
  }
  return true;
}

/** A box vs an obstacle: its bounding circle (broad phase), then, when it
 *  carries `parts`, the parts themselves (narrow phase, macro terrain C5b). */
function boxOverlapsObstacle(bx: number, by: number, hw: number, hh: number, o: GridObstacle): boolean {
  if (!boxOverlapsCircle(bx, by, hw, hh, o.x, o.y, o.radius)) return false;
  const parts = o.parts;
  if (parts === undefined) return true;
  const a = o.angle ?? 0, cos = Math.cos(a), sin = Math.sin(a);
  for (let p = 0; p < parts.length; p++) {
    if (boxOverlapsPolygon(bx, by, hw, hh, parts[p]!, o.x, o.y, cos, sin)) return true;
  }
  return false;
}

/**
 * The reason a `kindId` footprint at (x, y) cannot be placed, or `null` when it
 * is legal. A kind's `keepClear` box (a dock's landing pad) counts as
 * reserved: the new footprint may not overlap an existing entry's pad (entries
 * that carry `kind`), nor may the new kind's pad overlap an existing
 * footprint (`overlap-pad`). Links are not structures, so they may cross a
 * pad. Tests the sum-of-radii overlap against every `structures` entry and
 * every `obstacles` entry (asteroids: bounding circle, then the convex `parts`
 * when the obstacle has them). `obstacles` omitted/empty ⇒ structures-only
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
    const shw = s.halfW ?? s.radius, shh = s.halfH ?? s.radius;
    if (boxesOverlap(s.x, s.y, shw, shh, x, y, hw, hh)) return 'overlap-structure';
    const theirs = keepClearBox(s.kind, s.x, s.y, s.rot);
    if (theirs !== null && boxesOverlap(theirs.x, theirs.y, theirs.hw, theirs.hh, x, y, hw, hh)) return 'overlap-pad';
    const mine = keepClearBox(kindId, x, y, rotDeg);
    if (mine !== null && boxesOverlap(mine.x, mine.y, mine.hw, mine.hh, s.x, s.y, shw, shh)) return 'overlap-pad';
  }
  if (obstacles) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i]!;
      if (boxOverlapsObstacle(x, y, hw, hh, o)) return 'overlap-obstacle';
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
