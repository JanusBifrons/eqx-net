/**
 * Deterministic convex decomposition (ear-clipping) for simple polygons.
 *
 * Why this exists: the shield/hull refactor needs the **exact rendered ship
 * silhouette** as collision geometry once a ship's shield drops. 3 of the 5
 * ship kinds (scout, fighter, interceptor) are **concave** (a reflex tail
 * vertex), so a convex hull would fill the notch and NOT match what the
 * player sees. Ear-clipping decomposes any simple polygon (convex or
 * concave) into a set of triangles — trivially convex pieces — that exactly
 * tile the original. The result feeds BOTH the Rapier compound collider
 * (one `ColliderDesc.triangle` per piece) and the pure weapon hit-test
 * (`rayHitsConvexPolygon` looped over the pieces).
 *
 * **Determinism contract** (same guarantee `asteroidShape.ts` relies on):
 * only `+ - * /` and comparisons, fixed vertex-iteration ear order, no
 * trig / `Math.*`. Identical input ⇒ bit-identical output on Node and
 * Chromium. The per-kind geometry is precomputed ONCE at module load from
 * the frozen catalogue — zero per-tick / per-break allocation (core
 * CLAUDE.md physics rule).
 *
 * **Winding contract:** every emitted triangle is CCW in standard math
 * orientation (positive signed area). `rayHitsConvexPolygon` in
 * `Weapons.ts` computes its outward edge normal as `(edge.y, -edge.x)`,
 * which is only the *outward* normal for a CCW polygon — feeding it a CW
 * triangle inverts every half-space and the hit-test silently fails. The
 * triangulator normalises regardless of input winding (ship `points` are
 * authored Pixi-up, which is CW in standard orientation).
 */

import type { Vec2 } from '../swarm/asteroidShape.js';
import {
  SHIP_KINDS,
  DEFAULT_SHIP_KIND,
  type ShipKind,
  type ShipKindId,
} from '../../shared-types/shipKinds.js';

/** A single convex collision piece. Always CCW (positive signed area). */
export type Triangle = readonly [Vec2, Vec2, Vec2];

/** Shoelace signed area. CCW (standard math orientation) ⇒ positive. */
export function signedArea(poly: ReadonlyArray<Vec2>): number {
  const n = poly.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum * 0.5;
}

/** z of (a-o) × (b-o). > 0 ⇒ o→a→b is a CCW (left) turn. */
function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Strictly-inside test for a CCW triangle (a, b, c). On-edge and on-vertex
 * count as OUTSIDE so a polygon vertex shared with the candidate ear does
 * not falsely block the ear. Sufficient for the clean, collinear-free ship
 * polygons; the area-conservation unit test is the backstop.
 */
function pointStrictlyInCcwTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  return cross(a, b, p) > 0 && cross(b, c, p) > 0 && cross(c, a, p) > 0;
}

/**
 * Ear-clip `polygon` into CCW triangles. Handles convex AND concave simple
 * polygons. Returns `[]` for fewer than 3 vertices. Deterministic: scans
 * remaining vertices in index order and clips the first valid ear.
 */
export function triangulate(polygon: ReadonlyArray<Vec2>): Triangle[] {
  const n = polygon.length;
  if (n < 3) return [];

  // Work on a mutable index ring. Clip into CCW orientation so emitted
  // triangles are CCW by construction (ship `points` are CW in standard
  // orientation because they're authored Pixi-up).
  const ccw = signedArea(polygon) > 0;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);

  const tris: Triangle[] = [];
  let guard = 0;
  const guardMax = n * n + 1; // generous; a simple polygon clips in n-2 ears

  while (idx.length > 3 && guard++ < guardMax) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ip = idx[(i - 1 + idx.length) % idx.length]!;
      const ic = idx[i]!;
      const inx = idx[(i + 1) % idx.length]!;
      const a = polygon[ip]!;
      const b = polygon[ic]!;
      const c = polygon[inx]!;

      // Convex corner in a CCW polygon ⇒ cross(a,b,c) > 0.
      if (cross(a, b, c) <= 0) continue;

      // Ear iff no other (non-adjacent) vertex lies strictly inside abc.
      let blocked = false;
      for (let j = 0; j < idx.length; j++) {
        const vj = idx[j]!;
        if (vj === ip || vj === ic || vj === inx) continue;
        if (pointStrictlyInCcwTriangle(polygon[vj]!, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      tris.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    // Degenerate fallback (should not trigger for the clean ship shapes):
    // force-clip the first corner to guarantee progress + termination.
    if (!clipped) {
      const ip = idx[idx.length - 1]!;
      const ic = idx[0]!;
      const inx = idx[1]!;
      tris.push([polygon[ip]!, polygon[ic]!, polygon[inx]!]);
      idx.splice(0, 1);
    }
  }
  if (idx.length === 3) {
    tris.push([polygon[idx[0]!]!, polygon[idx[1]!]!, polygon[idx[2]!]!]);
  }
  // Drop any zero-area slivers a degenerate fallback may have produced so
  // consumers never see a collinear "triangle".
  return tris.filter((t) => signedArea(t) > 0);
}

// ---------------------------------------------------------------------------
// Per-kind precomputed ship collision geometry (built once at module load —
// the catalogue is frozen, so this never reallocates).
// ---------------------------------------------------------------------------

/** Catalogue `points` → entity-local Vec2[] with `scale` applied. Matches
 *  the renderer's `buildShipGfxFromShape` exactly so the collision polygon
 *  IS the rendered silhouette. */
export function shipShapeToPolygon(kind: ShipKind): Vec2[] {
  const s = kind.shape.scale;
  return kind.shape.points.map(([x, y]) => ({ x: x * s, y: y * s }));
}

function buildAll(): Record<ShipKindId, readonly Triangle[]> {
  const out = {} as Record<ShipKindId, readonly Triangle[]>;
  for (const kind of Object.values(SHIP_KINDS)) {
    out[kind.id] = Object.freeze(triangulate(shipShapeToPolygon(kind)));
  }
  return out;
}

/** Frozen per-kind collision triangle sets. Key = `ShipKindId`. */
export const SHIP_KIND_COLLISION_TRIANGLES: Readonly<
  Record<ShipKindId, readonly Triangle[]>
> = Object.freeze(buildAll());

/**
 * Triangles for a (possibly unknown) kind id. Falls back to the catalogue
 * default — same forgiving stance as `getShipKind`, so a malformed wire
 * value can never crash the collision path.
 */
export function shipCollisionTriangles(id: string | null | undefined): readonly Triangle[] {
  if (id != null && Object.prototype.hasOwnProperty.call(SHIP_KIND_COLLISION_TRIANGLES, id)) {
    return SHIP_KIND_COLLISION_TRIANGLES[id as ShipKindId]!;
  }
  return SHIP_KIND_COLLISION_TRIANGLES[DEFAULT_SHIP_KIND]!;
}
