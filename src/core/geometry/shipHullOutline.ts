/**
 * Ship-shape read seam (2026-06-13, composite-ships Phase 0).
 *
 * `ShipShape` is now a discriminated union (`'polygon' | 'composite'`). Rather
 * than scatter `kind.shape.kind === 'composite' ? … : …` narrowing across every
 * consumer that wants the collision outline, the draw scale, or the primary
 * colour, route those three reads through this seam. Polygon kinds (every kind
 * shipped today) get byte-identical values to the pre-union `kind.shape.points`
 * / `.scale` / `.color` reads, so this is a pure refactor with no behaviour
 * change.
 *
 * Imports the `ShipKind` type from shared-types the same way
 * `shipHullDecomp.ts` does (the `.js` extension is the ESM-resolution
 * convention used across the repo).
 */
import type { ShipKind } from '../../shared-types/shipKinds.js';

/**
 * The gross collision outline for a ship kind, Pixi-up local-space points.
 * For a composite shape this is the single `hull`; for a polygon shape it is
 * the polygon's `points`. This is the outline the physics collider + hitscan
 * see — per-part live collision is intentionally NOT modelled for composites.
 */
export function shipHullOutline(kind: ShipKind): ReadonlyArray<[number, number]> {
  return kind.shape.kind === 'composite' ? kind.shape.hull : kind.shape.points;
}

/** The uniform draw scale applied to a ship kind's shape. Present on both
 *  variants of the union. */
export function shipShapeScale(kind: ShipKind): number {
  return kind.shape.scale;
}

/** The ship kind's primary fill colour. For a polygon shape this is `color`;
 *  for a composite shape it is the first part's colour (the "body" tint). */
export function shipPrimaryColor(kind: ShipKind): number {
  return kind.shape.kind === 'composite'
    ? kind.shape.parts[0]!.color
    : kind.shape.color;
}
