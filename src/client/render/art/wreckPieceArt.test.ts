/**
 * Take 10 hostile review (2026-11-14): a dead robot-square's biggest piece
 * "keeps the robot's glowing eye, so it reads as a live robot". A sub-cap
 * wreck piece drew its parent's LIVE bake: the robot's emissive core ring, a
 * fighter's running lights and nozzles. The dead-piece bake (`dead: true`,
 * the forge's `scrap` look: no canopy, core, engines or running lights) is
 * the same hull, plating and size, so the wreck geometry's UVs line up.
 */
import { describe, it, expect } from 'vitest';
import { forgeShip, MAT } from './fields.js';
import { bakeKey } from './bake.js';
import { shipPpu } from './bake.js';

function lights(f: ReturnType<typeof forgeShip>): number {
  let n = 0;
  for (let i = 0; i < f.mat.length; i++) if (f.mat[i] === MAT.LIGHT) n++;
  return n;
}

describe('wreck piece art: broken, not alive (take 10)', () => {
  for (const id of ['robot-square', 'robot-circle', 'heavy', 'fighter']) {
    it(`${id}: the dead bake has no glowing core or running lights, same grid as the live bake`, () => {
      const live = forgeShip(id, { ppu: shipPpu(id) });
      const dead = forgeShip(id, { ppu: shipPpu(id), scrap: true });
      expect(dead.g.w).toBe(live.g.w);
      expect(dead.g.h).toBe(live.g.h);
      expect(lights(dead), `${id}: emissive texels on a dead piece`).toBe(0);
      expect(dead.navLights).toEqual([]);
      expect(dead.nozzles).toEqual([]);
      if (id.startsWith('robot')) expect(lights(live), `${id}: the live robot has its glowing core`).toBeGreaterThan(0);
    });
  }

  it('the dead bake has its own cache key', () => {
    expect(bakeKey({ type: 'ship', id: 'robot-square', dead: true })).not.toBe(bakeKey({ type: 'ship', id: 'robot-square' }));
  });
});
