/**
 * Derive a scrap piece's math-up convex-hull collider + radius from its parent
 * ship-kind + scrap-group component index — the SINGLE source for the
 * catalogue-Pixi-up → world-math-up mapping (`x*scale, -y*scale`) that the
 * death path (`ScrapSpawner`), the client (`scrapClientLeaf`), AND the
 * persistence hydrate path all need. Keeping it here means the restored scrap
 * collider is byte-identical to the one the original death produced.
 *
 * Zone-pure (src/core): no I/O, no side effects.
 */
import { shipScrapGroups } from './shipScrapGroups.js';
import { shipShapeScale } from './shipHullOutline.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

export interface ScrapColliderGeometry {
  /** Recentred scrap-group collider, scaled + Y-flipped to world math-up. */
  vertices: Vec2[];
  /** Max distance from the component origin to any collider vertex. */
  radius: number;
}

/**
 * The collider + radius for `shipScrapGroups(parentKind)[componentIndex]`.
 * Returns null for a polygon kind (no scrap groups) or an out-of-range index.
 */
export function scrapColliderFor(
  parentKind: ShipKindId,
  componentIndex: number,
): ScrapColliderGeometry | null {
  const groups = shipScrapGroups(parentKind);
  const g = groups[componentIndex];
  if (!g) return null;
  const scale = shipShapeScale(getShipKind(parentKind));
  const vertices: Vec2[] = g.collider.map(([x, y]) => ({ x: x * scale, y: -y * scale }));
  let radius = 0;
  for (const v of vertices) {
    const h = Math.hypot(v.x, v.y);
    if (h > radius) radius = h;
  }
  return { vertices, radius };
}
