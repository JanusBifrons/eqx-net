/**
 * No server tunnelling (capital fixes S14, owner: "most lasers tunnel very
 * badly"). A bolt covers `speed / 60` u per tick (the Bolt: 1600 / 60 ≈ 27 u,
 * far more than a thin hull is deep), so a per-tick point test would skip
 * thin hulls. The pipeline sweeps the whole step instead; this locks that for
 * EVERY projectile weapon in the catalogue, at its own speed and radius,
 * against EVERY ship kind's bare hull (shield down), crossed side-on at many
 * hull angles and from many start phases within one step.
 */
import { describe, expect, it } from 'vitest';
import { ProjectilePipeline, DT_SEC } from './ProjectilePipeline.js';
import { SLOT_ANGLE_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { WEAPON_IDS, getWeapon } from '../../core/combat/WeaponCatalogue.js';
import { shipCollisionParts } from '../../core/geometry/shipHullDecomp.js';
import { shipHitBound } from '../../core/combat/shipHitShape.js';

const PROJECTILE_WEAPONS = WEAPON_IDS.filter((id) => getWeapon(id).mode === 'projectile');

/** Centroid of a hull's first convex part (inside the hull by construction). */
function partCentroid(kindId: string): { x: number; y: number } {
  const part = shipCollisionParts(kindId)[0]!;
  let x = 0;
  let y = 0;
  for (const v of part) { x += v.x; y += v.y; }
  return { x: x / part.length, y: y / part.length };
}

describe('ProjectilePipeline — no tunnelling through thin hulls', () => {
  it('covers the bolt weapons', () => {
    expect(PROJECTILE_WEAPONS).toContain('laser');
    expect(PROJECTILE_WEAPONS).toContain('autocannon');
  });

  for (const weaponId of PROJECTILE_WEAPONS) {
    it(`${weaponId}: every hull, side-on at any angle and start phase, is hit`, () => {
      const def = getWeapon(weaponId);
      if (def.mode !== 'projectile') throw new Error('not a projectile');
      const step = def.speed * DT_SEC;
      const misses: string[] = [];
      for (const kind of SHIP_KINDS_LIST) {
        if (shipCollisionParts(kind.id).length === 0) continue;
        const c = partCentroid(kind.id);
        const bound = shipHitBound(kind.id);
        for (let deg = 0; deg < 180; deg += 15) {
          const angle = (deg * Math.PI) / 180;
          // The part centroid in world space (target centre at the origin).
          const cx = c.x * Math.cos(angle) - c.y * Math.sin(angle);
          const cy = c.x * Math.sin(angle) + c.y * Math.cos(angle);
          for (let phase = 0; phase < 1; phase += 0.125) {
            const sab = new Float32Array(4096);
            const b = slotBase(1);
            sab[b + SLOT_ANGLE_OFF] = angle;
            sab[b + SLOT_X_OFF] = 0;
            sab[b + SLOT_Y_OFF] = 0;
            let tick = 0;
            let hit: string | null = null;
            const pipe = new ProjectilePipeline({
              sabF32: sab,
              serverTick: () => tick,
              playerToSlot: [],
              getActiveShip: () => undefined,
              shipPoseCache: new Map(),
              playerSweep: () => null,
              swarmRegistry: {
                all: () => [{ id: 'target', slot: 1, radius: kind.radius, kind: 1, shipKind: kind.id, shieldDown: true }],
              },
              lingeringSlots: new Map(),
              applyDamage: (target) => { hit = target; },
            });
            // Fire along +y, side-on through the part centroid, from just
            // outside the hull's bound (offset by the phase of one step).
            const startY = cy - bound - def.radius - step * (1 + phase);
            pipe.spawn('shooter', cx, startY, 0, def.speed, def.damage, def.radius, 1000, weaponId);
            const ticks = Math.ceil((2 * bound + 2 * def.radius) / step) + 4;
            for (let i = 0; i < ticks && hit === null; i++) { pipe.advance(); tick++; }
            if (hit === null) misses.push(`${kind.id}@${deg}°/phase ${phase}`);
          }
        }
      }
      expect(misses).toEqual([]);
    });
  }
});
