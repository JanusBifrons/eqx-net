/**
 * Style C storage family, habitation (docs/plans/structure-restyle-stage4.md
 * §6): the habitat module and the residential spire. Each has a drawer, its
 * art stays in the footprint outline, its windows are warm when powered and
 * dead glass when not, and the family's bake key moved on.
 */
import { describe, expect, it } from 'vitest';
import { buildStructureVisual } from './structureVisuals.js';
import { structureStyleDrawer, structureStyleVersion } from './structureStyles.js';
import { insidePoly, outlinePx, polyEdgeDist } from './structureStyleKit.js';
import { kinds, version, WINDOW_DEAD, WINDOW_DIM, WINDOW_WARM } from './structureStyleC.storage.js';

const HAB = ['habitat_module', 'tower_module'] as const;

describe('storage: style C habitat and spire', () => {
  it('both kinds have a style C drawer, distinct from the vault and cargo bay', () => {
    for (const id of HAB) {
      expect(typeof kinds[id], id).toBe('function');
      expect(structureStyleDrawer('c', id), id).toBe(kinds[id]);
      expect(kinds[id]).not.toBe(kinds.storage_vault);
      expect(kinds[id]).not.toBe(kinds.cargo_bay);
      expect(structureStyleVersion('c', id), id).toBe(version);
    }
    expect(kinds.habitat_module).not.toBe(kinds.tower_module);
  });

  it('art stays inside the footprint outline, powered and unpowered, with livery', () => {
    for (const id of HAB) {
      for (const live of [true, false]) {
        const v = buildStructureVisual(id, { accent: 0xf2c46b, style: 'c', livery: true, powered: live });
        expect(v.polys!.length, id).toBeGreaterThan(60);
        expect(v.rects, id).toEqual([]);
        const out = outlinePx(id, 'c');
        for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
        for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
        for (const s of v.sigils ?? []) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
        expect(v.bands!.length, id).toBeGreaterThan(0);
        expect(v.polys!.some((p) => p.mat === 'hazard'), id).toBe(true);
        expect(live ? v.lights.length > 0 : v.lights.length === 0, `${id} lamps ${live}`).toBe(true);
      }
    }
  });

  it('windows are warm (a few dimmed) when powered, all dead glass when not', () => {
    for (const id of HAB) {
      const on = buildStructureVisual(id, { accent: 0xf2c46b, style: 'c', powered: true }).polys!;
      const off = buildStructureVisual(id, { accent: 0xf2c46b, style: 'c', powered: false }).polys!;
      const warm = on.filter((p) => p.mat === 'glow' && (p.color === WINDOW_WARM || p.color === WINDOW_DIM));
      expect(warm.length, id).toBeGreaterThan(20);
      expect(on.some((p) => p.color === WINDOW_WARM), id).toBe(true);
      expect(off.some((p) => p.mat === 'glow' && (p.color === WINDOW_WARM || p.color === WINDOW_DIM)), id).toBe(false);
      expect(off.filter((p) => p.mat === 'glow' && p.color === WINDOW_DEAD).length, id).toBeGreaterThanOrEqual(warm.length);
    }
  });
});
