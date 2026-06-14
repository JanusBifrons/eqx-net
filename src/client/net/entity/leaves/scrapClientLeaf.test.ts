/**
 * Regression lock for the Phase-5 scrap desync (Equinox Bugs doc, 2026-06-14):
 *
 *   "The scrap spawned and worked as intended, but when I flew into them it
 *    caused a huge spike in corrections so something isn't being simulated or
 *    replicated on both ends of the wire, clearly. There is a desync. This is a
 *    top priority to identify and fix."
 *
 * Root cause: the client spawned each scrap fragment as a LOCKED predWorld body
 * (`lockBody` makes it infinite-mass — "other bodies bounce off it as if it had
 * infinite mass", per `World.lockBody`'s own docstring), while the SERVER spawns
 * scrap DYNAMIC at mass 1 (`SwarmSpawner` → `staticBody: false`, "scrap is
 * dynamic — it drifts"). So the local player's PREDICTION bounced off an
 * immovable wall while the SERVER let the heavy ship shove the light debris
 * aside; every snapshot then reconciled that divergence as a correction spike.
 *
 * The fix makes the client scrap body a dynamic, unlocked, kinematic follower
 * (exactly like the drone leaf — see its docstring for the same lesson). This
 * test drives the local ship into a scrap fragment in the REAL predWorld and
 * asserts the fragment is SHOVED, matching the server simulation. With the old
 * locked body the fragment never moves and the test fails.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from '@core/physics/World';
import type { SwarmRenderState } from '@core/contracts/IRenderer';
import { ScrapClientLeaf } from './scrapClientLeaf.js';
import type { ClientSpawnCtx } from '../IClientEntityLeaf.js';

function makeScrapEntry(x: number, y: number): SwarmRenderState {
  // Only the spatial + kind fields are read by `spawnBody`; the interpolation
  // bookkeeping (poseRing/prev/arrival) is irrelevant to the collision body.
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    angvel: 0,
    radius: 30,
    kind: 3,
    shipKind: 'havok', // a composite kind → real scrap-group collider
    componentIndex: 0,
  } as SwarmRenderState;
}

describe('ScrapClientLeaf — predWorld body is server-faithful (dynamic, pushable)', () => {
  let world: PhysicsWorld;
  beforeAll(async () => {
    world = await PhysicsWorld.create();
  });

  it('a scrap fragment is SHOVED when the local ship flies into it (not an infinite-mass wall)', () => {
    const leaf = new ScrapClientLeaf();
    const scrapKey = 'swarm-90001';
    const ctx: ClientSpawnCtx = {
      predWorld: world,
      aiController: {
        register: () => undefined,
        unregister: () => undefined,
      } as unknown as ClientSpawnCtx['aiController'],
      entityId: 90001,
      key: scrapKey,
      entry: makeScrapEntry(0, 80),
      registeredAiId: null,
    };
    leaf.spawnBody(ctx);

    // Local ship at the origin, thrusting straight up (+Y at angle 0) into the
    // scrap fragment parked at (0, 80).
    world.spawnShip('local', 0, 0);
    const start = world.getShipState(scrapKey)!;
    expect(start).not.toBeNull();
    for (let i = 0; i < 300; i++) {
      world.applyInput('local', { thrust: true, turnLeft: false, turnRight: false });
      world.tick(1 / 60);
    }
    const end = world.getShipState(scrapKey)!;
    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    // Dynamic mass-1 scrap (server parity) is shoved well clear; a LOCKED
    // infinite-mass body would not move at all (moved ≈ 0 → fails on old code).
    expect(moved).toBeGreaterThan(5);
  });
});
