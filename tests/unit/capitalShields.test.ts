/**
 * Capital ships never have shields (owner 2026-11-16). Every capital has
 * `shieldMax` 0 (`kindHasShield` false), and a capital body spawns with its
 * hull exposed. `shieldVisualRadius` still gives a capital its half beam
 * (read by the lock-mark `hullHalfBeam`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { shipShieldColliderDesc } from '../../src/core/physics/colliderConfig.js';
import { SHIP_KINDS_LIST, getShipKind, kindHasShield } from '../../src/shared-types/shipKinds.js';
import { shieldVisualRadius } from '../../src/shared-types/shipScale/tuning.js';

function beamOf(id: string): number {
  const hull = (getShipKind(id).shape as { hull?: ReadonlyArray<readonly [number, number]> }).hull ?? [];
  let w = 0;
  for (const [x] of hull) w = Math.max(w, Math.abs(x));
  return 2 * w;
}

describe('capitals have no shield', () => {
  beforeAll(async () => { await RAPIER.init(); });

  it('every capital has shieldMax 0', () => {
    const caps = SHIP_KINDS_LIST.filter((k) => k.sizeClass === 'capital');
    expect(caps.length).toBeGreaterThan(0);
    for (const k of caps) {
      expect(k.shieldMax).toBe(0);
      expect(kindHasShield(k)).toBe(false);
    }
  });

  it('a capital spawns hull-exposed; a fighter keeps its shield ball', async () => {
    const world = await PhysicsWorld.create();
    world.spawnShip('cap', 0, 0, 'light-cruiser');
    world.spawnShip('f', 50_000, 0, 'fighter');
    expect(world.isHullExposed('cap')).toBe(true);
    expect(world.isHullExposed('f')).toBe(false);
    expect(shipShieldColliderDesc(getShipKind('fighter')).shape.type).toBe(RAPIER.ShapeType.Ball);
  });

  it('shieldVisualRadius: a capital uses its half beam, every other kind its radius', () => {
    const bb = getShipKind('battleship');
    expect(shieldVisualRadius(bb)).toBeCloseTo(beamOf('battleship') / 2, 6);
    expect(shieldVisualRadius(getShipKind('fighter'))).toBe(getShipKind('fighter').radius);
  });
});
