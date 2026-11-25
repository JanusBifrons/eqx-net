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

/** Allowed structure rotations (degrees), in 30° steps (base platforms: hex
 *  sides are slanted, so a deck building turns in twelfths). The value is
 *  DEGREES everywhere it travels (place_structure.rot, the registry's `rot`,
 *  the save's `structures[].rot`; the swarm angle carries it in radians), so
 *  the quarter turns 0/90/180/270 keep their meaning: no migration. A room
 *  without the `deck` flag still turns in quarters
 *  (`normaliseStructureQuarterTurn`, applied to the player's message). */
export const STRUCTURE_ROTATION_STEP_DEG = 30;
export const STRUCTURE_ROTATIONS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] as const;
export type StructureRotation = (typeof STRUCTURE_ROTATIONS)[number];

/** Normalise any angle-ish input to one of the twelve allowed rotations. */
export function normaliseStructureRotation(deg: number | null | undefined): StructureRotation {
  const step = STRUCTURE_ROTATION_STEP_DEG;
  const r = (((Math.round((deg ?? 0) / step) * step) % 360) + 360) % 360;
  return r as StructureRotation;
}

/** Normalise any angle-ish input to a quarter turn (0/90/180/270): the rule
 *  in a room without the `deck` flag. */
export function normaliseStructureQuarterTurn(deg: number | null | undefined): StructureRotation {
  const r = (((Math.round((deg ?? 0) / 90) * 90) % 360) + 360) % 360;
  return r as StructureRotation;
}

/** The step a PLAYER's building turns by: 30° on a `deck` room, a quarter
 *  turn elsewhere. One rule for the ghost's rotate control and the server's
 *  `place_structure` snap (invariant 15). */
export function playerStructureRotationStep(deck: boolean): number {
  return deck ? STRUCTURE_ROTATION_STEP_DEG : 90;
}

/** A PLAYER's requested rotation snapped by the room's rule
 *  (`playerStructureRotationStep`). */
export function snapPlayerStructureRotation(deg: number | null | undefined, deck: boolean): StructureRotation {
  return deck ? normaliseStructureRotation(deg) : normaliseStructureQuarterTurn(deg);
}

/** Axis-aligned half extents of a kind's footprint at a rotation (a quarter
 *  turn swaps width and height). The ONE place every rule reads the box from:
 *  placement overlap, connection edge distance + line of sight, hit tests. */
export function structureHalfExtents(
  kindId: string | null | undefined,
  rotDeg: number | null | undefined = 0,
): { hw: number; hh: number } {
  return structureHalfExtentsInto(kindId, rotDeg, { hw: 0, hh: 0 });
}

/** `structureHalfExtents` written into `out` (alloc-free, for per-message
 *  and per-tick callers). Returns `out`. */
export function structureHalfExtentsInto<T extends { hw: number; hh: number }>(
  kindId: string | null | undefined,
  rotDeg: number | null | undefined,
  out: T,
): T {
  const id = kindId != null && isStructureKindId(kindId) ? kindId : DEFAULT_STRUCTURE_KIND;
  const { w, h } = getStructureKind(id).footprint;
  // The NEAREST quarter turn decides the swap (30° keeps the box, 60° swaps).
  // TODO(bp-16): oriented box — an odd-30° turn is approximated by this
  // axis-aligned box (every caller of structureHalfExtents inherits it).
  const quarter = normaliseStructureQuarterTurn(rotDeg) % 180 !== 0;
  out.hw = quarter ? h / 2 : w / 2;
  out.hh = quarter ? w / 2 : h / 2;
  return out;
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
