/**
 * Structure geometry — hull points, rotations and footprint half extents.
 */
import { DEFAULT_STRUCTURE_KIND, getStructureKind, isStructureKindId } from './lookup.js';

// ── Unified entity hull (unified-hull plan) ────────────────────────────────
/**
 * The structure's hull POINTS, today the footprint BOX. SINGLE SOURCE for the
 * polygon COLLIDER (server `SwarmSpawner.spawnStructure` + client
 * `structureClientLeaf`, consumed in GAME space, Y-up) AND, via the renderer's
 * `structureRenderVerts` (`pixiY = -gameY`, the flip every entity obeys), the
 * rendered silhouette. **Stage 3 (structure-restyle plan §6) flips this to
 * return `structureOutline`**, with concave outlines decomposed by
 * `convexParts` (`core/geometry/shipHullDecomp.ts`); until then colliders stay
 * the box. The convex-hull collider is vertex-order-invariant, so ONLY the
 * render flip matters (an asymmetric outline renders MIRRORED without it: the
 * R2.13 "turret appears upside down" bug). Called once at sprite-create /
 * entity-spawn, never in a hot loop. Unknown id ⇒ the Capital's box, the same
 * forgiving stance as `getStructureKind`.
 */
export function structureHullPoints(
  kindId: string | null | undefined,
  radius?: number,
): Array<{ x: number; y: number }> {
  let hw: number, hh: number;
  if (kindId != null && isStructureKindId(kindId)) {
    const { w, h } = getStructureKind(kindId).footprint;
    hw = w / 2;
    hh = h / 2;
  } else if (radius !== undefined && radius > 0) {
    // A KINDLESS structure (test fixtures, e.g. `structurePoses`): a square
    // sized by its radius — never the Capital's 560 u box.
    hw = radius;
    hh = radius;
  } else {
    const { w, h } = getStructureKind(DEFAULT_STRUCTURE_KIND).footprint;
    hw = w / 2;
    hh = h / 2;
  }
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
}

/** Allowed structure rotations (degrees). Structures are rectangles, so a
 *  quarter-turn swaps width and height; 180° is visually distinct only for
 *  the draw plan (e.g. which side a turret's ammo racks sit on). */
export const STRUCTURE_ROTATIONS = [0, 90, 180, 270] as const;
export type StructureRotation = (typeof STRUCTURE_ROTATIONS)[number];

/** Normalise any angle-ish input to one of the four allowed rotations. */
export function normaliseStructureRotation(deg: number | null | undefined): StructureRotation {
  const r = (((Math.round((deg ?? 0) / 90) * 90) % 360) + 360) % 360;
  return r as StructureRotation;
}

/** Axis-aligned half extents of a kind's footprint at a rotation (a quarter
 *  turn swaps width and height). The ONE place every rule reads the box from:
 *  placement overlap, connection edge distance + line of sight, hit tests. */
export function structureHalfExtents(
  kindId: string | null | undefined,
  rotDeg: number | null | undefined = 0,
): { hw: number; hh: number } {
  const id = kindId != null && isStructureKindId(kindId) ? kindId : DEFAULT_STRUCTURE_KIND;
  const { w, h } = getStructureKind(id).footprint;
  const quarter = normaliseStructureRotation(rotDeg) % 180 !== 0;
  return quarter ? { hw: h / 2, hh: w / 2 } : { hw: w / 2, hh: h / 2 };
}

/**
 * Structure LOCAL → WORLD: the ONE transform every shape rule shares (build
 * mirror, base loop 4A). Mirror is a left-right flip, x → −x in the
 * structure's local frame (game space, y up), applied FIRST; then the turn by
 * (`cos`, `sin`) (CCW); then the move to the centre (`cx`, `cy`). For a
 * direction (a socket normal) pass `cx = cy = 0`. Alloc-free: writes `out`.
 */
export function structureLocalToWorld(
  lx: number, ly: number,
  cx: number, cy: number,
  cos: number, sin: number,
  mirror: boolean | undefined,
  out: { x: number; y: number },
): { x: number; y: number } {
  const mx = mirror === true ? -lx : lx;
  out.x = cx + mx * cos - ly * sin;
  out.y = cy + mx * sin + ly * cos;
  return out;
}

/**
 * WORLD → structure LOCAL: the exact inverse of `structureLocalToWorld`
 * (move to the centre, undo the turn, then undo the mirror flip). For a
 * direction pass `cx = cy = 0`. Alloc-free: writes `out`.
 */
export function structureWorldToLocal(
  wx: number, wy: number,
  cx: number, cy: number,
  cos: number, sin: number,
  mirror: boolean | undefined,
  out: { x: number; y: number },
): { x: number; y: number } {
  const dx = wx - cx, dy = wy - cy;
  const ux = dx * cos + dy * sin;
  out.y = -dx * sin + dy * cos;
  out.x = mirror === true ? -ux : ux;
  return out;
}
