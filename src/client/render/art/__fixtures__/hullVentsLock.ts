/**
 * Shared body of the hull-vent locks (`hullVents*.test.ts`), one file per
 * capital so vitest runs the forges in parallel. Story and lock: see
 * `hullVents.test.ts`.
 */
import { forgeShip } from '../fields.js';
import { shipTurrets } from '../turretLayout.js';
import { shipPpu } from '../bake.js';

/** Forge `id` at its real ppu with its turret rings and list every vent slit
 *  that touches a ring (its stamped extent, r × 1.15). Empty = clear. */
export function ventsTouchingRings(id: string): string[] {
  const rings = shipTurrets(id).map((t) => ({ x: t.px, y: t.py, r: t.ring, id: t.mount.id }));
  const f = forgeShip(id, { ppu: shipPpu(id), rings });
  const hits: string[] = [];
  for (const v of f.vents ?? []) {
    for (const rg of rings) {
      const dx = Math.max(0, Math.abs(rg.x - v.x) - v.hw), dy = Math.max(0, Math.abs(rg.y - v.y) - v.hh);
      if (Math.hypot(dx, dy) < rg.r * 1.15) hits.push(`${rg.id} (vent at ${v.x.toFixed(0)}, ${v.y.toFixed(0)})`);
    }
  }
  return hits;
}
