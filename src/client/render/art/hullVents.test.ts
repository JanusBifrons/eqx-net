/**
 * Showcase review (#376, gpu-lit-ships, `capital-guns-fighter` take): "A thin
 * dark rod sticks out behind each 5-inch turret, opposite its barrels."
 *
 * Found with an in-game probe (hide the turret clusters: the rod stays; hide
 * the hull: it goes): the rod is in the HULL bake, not the turret art. The
 * hull's vent-slit greeble (three slits a third of the way up from the stern,
 * sized for a fighter) lands on a capital as a one-texel-thick, ~110 u long
 * TRIM line. On the battleship it ran straight out of the quad 40 mm AA tubs
 * at aa-s2 / aa-p2 (the small turrets the review called 5-inch), whose guns
 * cover its outboard end, so it read as a rod behind the turret. The baked
 * frames and the GPU-lit maps come from the same fields, so both showed it.
 *
 * Lock: no vent slit touches a turret ring (its stamped extent, r × 1.15).
 * Kinds: the battleship from the review plus the other capitals whose slits
 * hit a ring before the fix (each forge is a few seconds at its real ppu).
 */
import { describe, it, expect } from 'vitest';
import { forgeShip } from './fields.js';
import { shipTurrets } from './turretLayout.js';
import { shipPpu } from './bake.js';

const KINDS = ['battleship', 'battleship-c', 'light-cruiser-c'];

describe('capital hull vents stay clear of turret rings', () => {
  it.each(KINDS)('%s', (id) => {
    const rings = shipTurrets(id).map((t) => ({ x: t.px, y: t.py, r: t.ring, id: t.mount.id }));
    const f = forgeShip(id, { ppu: shipPpu(id), rings });
    const hits: string[] = [];
    for (const v of f.vents ?? []) {
      for (const rg of rings) {
        const dx = Math.max(0, Math.abs(rg.x - v.x) - v.hw), dy = Math.max(0, Math.abs(rg.y - v.y) - v.hh);
        if (Math.hypot(dx, dy) < rg.r * 1.15) hits.push(`${rg.id} (vent at ${v.x.toFixed(0)}, ${v.y.toFixed(0)})`);
      }
    }
    expect(hits).toEqual([]);
  }, 60_000);
});
