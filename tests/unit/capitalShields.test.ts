/**
 * Capital-ship R&D round 3 (plan eager-sauteeing-curry, B): shields follow the
 * hull. In round 2 the fighter fly-by stopped dead in the channel between two
 * cruisers (logged pose: stuck at y ≈ -236, ~269 u from the light cruiser's
 * centre) because every shield was a ball of half the hull's length. This
 * drives the REAL physics world: a fighter thrusts up the channel between two
 * parked capitals and must come out the far end, and the same layout with
 * ball shields must still block it (so the test proves the shape matters).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { shipShieldColliderDesc } from '../../src/core/physics/colliderConfig.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import { massOf } from '../../src/shared-types/shipScale/tuning.js';

const up = { thrust: true, reverse: false, turnLeft: false, turnRight: false, boost: false };

function beamOf(id: string): number {
  const hull = (getShipKind(id).shape as { hull?: ReadonlyArray<readonly [number, number]> }).hull ?? [];
  let w = 0;
  for (const [x] of hull) w = Math.max(w, Math.abs(x));
  return 2 * w;
}

describe('capital shields follow the hull', () => {
  beforeAll(async () => { await RAPIER.init(); });

  it('a capital shield is a rounded convex hull, every other kind keeps its ball', () => {
    const cap = shipShieldColliderDesc(getShipKind('light-cruiser'));
    const fighter = shipShieldColliderDesc(getShipKind('fighter'));
    expect(cap.shape.type).toBe(RAPIER.ShapeType.RoundConvexPolygon);
    expect(fighter.shape.type).toBe(RAPIER.ShapeType.Ball);
  });

  const flyChannel = async (hullShields: boolean): Promise<number> => {
    const world = await PhysicsWorld.create();
    const id = 'light-cruiser';
    const k = getShipKind(id);
    // Two cruisers side by side, a channel of three beams between their hulls.
    const gap = beamOf(id) * 4;
    for (const [i, x] of [[0, -gap / 2], [1, gap / 2]] as const) {
      world.spawnObstacle(`cap-${i}`, x, 0, k.radius, massOf(k, 3), undefined, k.linearDamping, undefined, undefined, hullShields ? k : undefined);
    }
    world.spawnShip('fighter', 0, -k.radius - 200, 'fighter');
    for (let t = 0; t < 60 * 30; t++) {
      world.applyInput('fighter', up);
      world.tick(1 / 60);
      if (world.getShipState('fighter')!.y > k.radius + 100) break;
    }
    return world.getShipState('fighter')!.y;
  };

  it('a fighter flies the channel between two parked capitals (hull-shaped shields)', async () => {
    const k = getShipKind('light-cruiser');
    expect(await flyChannel(true)).toBeGreaterThan(k.radius + 100);
  });

  it('the same channel with ball shields is walled off (the round-2 failure)', async () => {
    expect(await flyChannel(false)).toBeLessThan(0);
  });
});

describe('capital shield effects are sized to the hull, not its length', () => {
  it('shieldVisualRadius: a capital uses its half beam, every other kind its radius', async () => {
    const { shieldVisualRadius } = await import('../../src/shared-types/shipScale/tuning.js');
    const bb = getShipKind('battleship');
    expect(shieldVisualRadius(bb)).toBeCloseTo(beamOf('battleship') / 2, 6);
    expect(shieldVisualRadius(bb)).toBeLessThan(bb.radius / 5);
    expect(shieldVisualRadius(getShipKind('fighter'))).toBe(getShipKind('fighter').radius);
  });
});
