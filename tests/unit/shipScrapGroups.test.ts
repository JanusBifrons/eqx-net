/**
 * Scrap-group geometry tests (scrap-on-death Phase 2a, Step A). Asserts the
 * pure `shipScrapGroups` precompute over the catalogue:
 *  - Havok (composite) yields 7 groups (2 rear-wing, 2 wing, 2 pad, 1 cockpit)
 *  - every group's collider is a non-degenerate polygon (>= 3 points)
 *  - the cockpit group carries the green dome detail (colour 0x33dd55)
 *  - a polygon kind (fighter) yields an empty array
 *  - group centroids are distinct (the components are spatially separated)
 */
import { describe, it, expect } from 'vitest';
import { shipScrapGroups } from '../../src/core/geometry/shipScrapGroups.js';

describe('shipScrapGroups', () => {
  it('Havok yields 7 scrap groups (2 rear-wing, 2 wing, 2 pad, 1 cockpit)', () => {
    const groups = shipScrapGroups('havok');
    expect(groups).toHaveLength(7);
  });

  it('every Havok group collider has >= 3 points', () => {
    const groups = shipScrapGroups('havok');
    for (const g of groups) {
      expect(g.collider.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('the cockpit group contains the green dome part (colour 0x33dd55)', () => {
    const groups = shipScrapGroups('havok');
    // The cockpit group is the one whose silhouette centroid is forward-most
    // (most negative y in Pixi-up) — but more robustly, exactly one group
    // carries a part coloured 0x33dd55 (the dome), and it is the cockpit.
    const withDome = groups.filter((g) =>
      g.parts.some((p) => p.color === 0x33dd55),
    );
    expect(withDome).toHaveLength(1);
    // The dome rides WITH a primary silhouette + the other cockpit details, so
    // the group has more than one part.
    expect(withDome[0]!.parts.length).toBeGreaterThan(1);
  });

  it('a polygon kind (fighter) yields an empty array', () => {
    expect(shipScrapGroups('fighter')).toHaveLength(0);
  });

  it('an unknown kind yields an empty array', () => {
    expect(shipScrapGroups('no-such-kind')).toHaveLength(0);
    expect(shipScrapGroups(null)).toHaveLength(0);
    expect(shipScrapGroups(undefined)).toHaveLength(0);
  });

  it('group centroids are distinct (components are spatially separated)', () => {
    const groups = shipScrapGroups('havok');
    const seen = new Set<string>();
    for (const g of groups) {
      const key = `${g.centroid[0].toFixed(4)},${g.centroid[1].toFixed(4)}`;
      expect(seen.has(key), `duplicate centroid ${key}`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(7);
  });

  it('each group recentres its parts on the group centroid (silhouette mean ~ 0)', () => {
    const groups = shipScrapGroups('havok');
    for (const g of groups) {
      // The first part is the silhouette; its recentred points must average to
      // ~the origin (that is what "recentred on the centroid" means).
      const sil = g.parts[0]!;
      let cx = 0;
      let cy = 0;
      for (const [x, y] of sil.points) {
        cx += x;
        cy += y;
      }
      cx /= sil.points.length;
      cy /= sil.points.length;
      expect(cx).toBeCloseTo(0, 6);
      expect(cy).toBeCloseTo(0, 6);
    }
  });
});
