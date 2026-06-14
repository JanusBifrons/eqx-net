import { describe, it, expect } from 'vitest';
import { scrapColliderFor } from './scrapCollider.js';
import { shipScrapGroups } from './shipScrapGroups.js';

/**
 * scrapColliderFor is the single source for the scrap collider mapping shared by
 * the death path (ScrapSpawner), the client (scrapClientLeaf) and the
 * persistence hydrate path — so a restored scrap collider is identical.
 */
describe('scrapColliderFor', () => {
  it('returns a math-up convex hull + radius for a composite kind component', () => {
    const groups = shipScrapGroups('havok');
    expect(groups.length).toBeGreaterThan(0); // havok is composite
    const geom = scrapColliderFor('havok', 0);
    expect(geom).not.toBeNull();
    expect(geom!.vertices.length).toBeGreaterThanOrEqual(3);
    // radius is the max distance from origin to any vertex (positive, finite).
    expect(geom!.radius).toBeGreaterThan(0);
    expect(Number.isFinite(geom!.radius)).toBe(true);
    for (const v of geom!.vertices) {
      expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(geom!.radius + 1e-6);
    }
  });

  it('returns null for an out-of-range component index', () => {
    const groups = shipScrapGroups('havok');
    expect(scrapColliderFor('havok', groups.length)).toBeNull();
  });

  it('returns null for a polygon (non-composite) kind that sheds no scrap', () => {
    // A polygon ship-kind has zero scrap groups → any index is null.
    expect(scrapColliderFor('fighter', 0)).toBeNull();
  });
});
