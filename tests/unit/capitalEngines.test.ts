/**
 * Capitals review round, item 1 (plan prancy-squishing-donut Phase 2): capital
 * engines. The baked nozzles (which place the flame + ribbon exhaust) used a
 * fixed size cap (`Math.min(5, ...)`) and ignored the kind's authored
 * `thrusters`, so a 5,760 u battleship had a pair of <= 5 u nozzles and no
 * visible exhaust at any zoom (capital-pilot clip, 2026-11-06). A size-dependent
 * number authored as a constant: invariant #18.
 */
import { describe, it, expect } from 'vitest';
import { forgeShip } from '../../src/client/render/art/fields';
import { getShipKind } from '../../src/shared-types/shipKinds';

const CAPITALS = ['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship'];

describe('capital engines follow the authored thrusters', () => {
  for (const id of CAPITALS) {
    it(`${id}: nozzle count and size come from kind.thrusters`, () => {
      const kind = getShipKind(id);
      const t = kind.thrusters!;
      expect(t, 'capitals author their thrusters').toBeDefined();
      const f = forgeShip(id, { ppu: 0.08 });
      expect(f.nozzles.length).toBe(t.count);
      for (const n of f.nozzles) expect(n.r * 2).toBeCloseTo(t.size, 0);
      // All astern, spread across the beam (not stacked on the centreline).
      if (t.count > 1) expect(new Set(f.nozzles.map((n) => Math.round(n.x))).size).toBe(t.count);
    });

    it(`${id}: flat stern holds the bank at the very back, with a hull-scale plume`, () => {
      const kind = getShipKind(id);
      const f = forgeShip(id, { ppu: 0.08 });
      // Stern extent of the hull outline (local +y is astern).
      const shape = kind.shape as { parts: Array<{ points: Array<[number, number]> }> };
      let stern = 0;
      for (const p of shape.parts) for (const [, y] of p.points) stern = Math.max(stern, y * (kind.appliedScale ?? 1));
      for (const n of f.nozzles) {
        // Within a couple of nozzle radii of the transom, not stepped forward.
        expect(Math.abs(stern - n.y)).toBeLessThan(n.r * 3);
        // Full-thrust flame ≈ 8.4 r × len ≈ an eighth of the hull length.
        const flame = 8.4 * n.r * (n.len ?? 1);
        expect(flame).toBeGreaterThan(0.2 * kind.radius);
      }
    });
  }

  it('a fighter keeps its small authored-at-1x nozzles', () => {
    const f = forgeShip('fighter', { ppu: 6 });
    expect(f.nozzles.length).toBeGreaterThan(0);
    for (const n of f.nozzles) expect(n.r).toBeLessThanOrEqual(5 * (getShipKind('fighter').appliedScale ?? 1));
  });
});
