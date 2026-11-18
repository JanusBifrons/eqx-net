/**
 * Structure geometry — hull points, rotations and footprint half extents.
 */
import { DEFAULT_STRUCTURE_KIND, getStructureKind, isStructureKindId } from './lookup.js';

/**
 * The structure's hull POINTS — a regular N-gon at `radius`, first vertex at
 * `(0, -radius)` going clockwise. SINGLE SOURCE for the polygon COLLIDER (server
 * `SwarmSpawner.spawnStructure` + client `structureClientLeaf`, consumed in GAME
 * space, Y-up) AND — via the renderer's `structureRenderVerts` (`pixiY = -gameY`,
 * the flip every entity obeys) — the rendered silhouette. **A regular polygon is
 * Y-flip-invariant ONLY for an EVEN side-count.** The ODD-sided structures
 * (turret 3, miner 5, shield_pylon 7) are NOT, so the renderer MUST apply the
 * flip or the silhouette renders MIRRORED vs the collider — the R2.13 "the
 * collision box is right but the turret appears upside down" bug, which is why
 * `buildStructureGfx` no longer draws these points directly. The convex-hull
 * collider is vertex-order-invariant, so ONLY the render flip matters. Called
 * once at sprite-create / entity-spawn, never in a hot loop. Unknown id ⇒ the
 * Capital's silhouette, the same forgiving stance as `getStructureKind`.
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
