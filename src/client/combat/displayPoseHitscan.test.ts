/**
 * The local beam / hit-prediction ray after the remote-entity paradigm
 * (2026-11-08). A drone's predWorld body now runs on the predicted timeline
 * and LEADS its sprite; the turret aims at the sprite. The ray must test the
 * drone where it is DRAWN (so the beam ends on the sprite and the predicted
 * hit matches "turret on target"), and must not stop on the leading body.
 * Everything that is not a remote drone/scrap still goes through predWorld.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { DisplayPoseHitscan, rayHitsDrawnSwarmEntity } from './displayPoseHitscan.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

beforeAll(async () => {
  await RAPIER.init();
});

function drone(x: number, y: number, shieldDown = false): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 12, kind: 1, shipKind: 'fighter', shieldDown,
    sleeping: false, lastUpdateTick: 0, prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0,
    latestArrivalMs: 0, poseRing: [], ringHead: 0,
  } as unknown as SwarmRenderState;
}

async function setup(): Promise<{ w: PhysicsWorld; h: DisplayPoseHitscan; swarm: Map<number, SwarmRenderState>; keys: Map<number, string> }> {
  const w = await PhysicsWorld.create();
  w.spawnShip('me', 0, 0);
  // Drone 1: DRAWN at (0, 200); its predicted-timeline body leads to (80, 200).
  w.spawnObstacle('swarm-1', 80, 200, 12, 3);
  // An asteroid straight ahead further out (a predWorld-only body).
  w.spawnObstacle('swarm-9', 0, 400, 30, 3);
  w.tick(1 / 60); // query pipeline
  const swarm = new Map<number, SwarmRenderState>([[1, drone(0, 200)]]);
  const moving = new Set(['swarm-1']);
  const keys = new Map([[1, 'swarm-1'], [9, 'swarm-9']]);
  const h = new DisplayPoseHitscan(moving, keys);
  h.world = w;
  h.swarm = swarm;
  return { w, h, swarm, keys };
}

describe('DisplayPoseHitscan', () => {
  it('a ray at the DRAWN drone hits it (ends on the sprite), not the leading body', async () => {
    const { w, h } = await setup();
    const hit = h.hitscan(0, 0, 0, 1, 500, 'me');
    expect(hit?.hitId).toBe('swarm-1');
    // Shield-up drone: the shield circle edge, 200 − (12 + pad).
    expect(hit!.dist).toBeLessThan(200 - 12);
    expect(hit!.dist).toBeGreaterThan(150);
    w.dispose();
  });

  it('a ray through the leading body (nothing drawn there) passes it', async () => {
    const { w, h } = await setup();
    // Straight up the x = 80 line: the body is there, the sprite is not.
    const hit = h.hitscan(80, 0, 0, 1, 500, 'me');
    expect(hit).toBeNull();
    // Raw predWorld would have stopped on the body: the old behaviour this replaces.
    expect(w.hitscan(80, 0, 0, 1, 500, 'me')?.hitId).toBe('swarm-1');
    w.dispose();
  });

  it('non-moving predWorld bodies are still hit through predWorld', async () => {
    const { w, h, swarm } = await setup();
    swarm.get(1)!.x = 300; // drone drawn out of the way
    const hit = h.hitscan(0, 0, 0, 1, 500, 'me');
    expect(hit?.hitId).toBe('swarm-9');
    expect(hit!.dist).toBeCloseTo(370, 0);
    w.dispose();
  });

  it('shield-down drones are hit on the hull, closer in than the shield ring', async () => {
    const { w, h, swarm } = await setup();
    const up = h.hitscan(0, 0, 0, 1, 500, 'me')!.dist;
    swarm.set(1, drone(0, 200, true));
    const down = h.hitscan(0, 0, 0, 1, 500, 'me');
    expect(down?.hitId).toBe('swarm-1');
    expect(down!.dist).toBeGreaterThan(up);
    w.dispose();
  });

  // No weapon touches a loot pod (owner 2026-11-17): the drawn beam never ends
  // on one, as the server's shots pass it (shared `isLootPod`, #15).
  it('no drawn beam ends on a loot pod; other scrap still stops it', () => {
    const pod = { ...drone(0, 100, false), kind: 3, radius: 9, shipKind: 'cargo-pod' } as SwarmRenderState;
    expect(rayHitsDrawnSwarmEntity(pod, 0, 0, 0, 1, 400)).toBeNull();
    expect(rayHitsDrawnSwarmEntity(pod, 0, 0, 0, 1, 400, undefined, 12)).toBeNull();
    const scrap = { ...pod, shipKind: undefined } as SwarmRenderState;
    expect(rayHitsDrawnSwarmEntity(scrap, 0, 0, 0, 1, 400)).not.toBeNull();
  });

  // 2026-11-13: the circle gate was `rayHitsSphere`, null once the ray starts
  // inside the circle past the centre, so a beam fired from beside a capital
  // (its circle is half the hull's length) across the far half missed. Same
  // gate as the server's `refineRayHit` (#15).
  for (const shieldDown of [false, true]) {
    it(`a beam from beside a ${shieldDown ? 'shield-down' : 'shield-up'} capital, away from its centre, hits the far half`, () => {
      const R = getShipKind('battleship').radius;
      const bb = { ...drone(0, 0, shieldDown), radius: R, shipKind: 'battleship' } as SwarmRenderState;
      const fx = R * 0.2;
      const fy = -R * 0.5;
      const d = -Math.SQRT1_2;
      expect(rayHitsDrawnSwarmEntity(bb, fx, fy, d, d, R)).not.toBeNull();
      // Beside the hull and heading away from it: still a miss.
      expect(rayHitsDrawnSwarmEntity(bb, fx, fy, 1, 0, R)).toBeNull();
    });
  }

  // Showcase review (wreck-resplit take 5): a lance battlecruiser's beams on a
  // locked wreck piece 5 km off were drawn their full 20 km straight through
  // it. Wreck pieces stream into the predWorld only near the local ship
  // (PREDWORLD_WRECK_RADIUS), and this ray tested only entities with a body,
  // so a far piece was invisible to it while the server's beam stopped on it.
  it('a wreck piece with no predWorld body (far, streamed out) still stops the beam at its drawn hull', async () => {
    const { w, h, swarm, keys } = await setup();
    swarm.get(1)!.x = 300; // drone out of the way
    const square = [[{ x: -40, y: -40 }, { x: 40, y: -40 }, { x: 40, y: 40 }, { x: -40, y: 40 }]];
    swarm.set(7, { ...drone(0, 250), kind: 4, radius: 57, shipKind: undefined, wreckId: 3, componentIndex: 0 } as unknown as SwarmRenderState);
    h.wrecks = { has: (id) => id === 3, piece: (id) => (id === 3 ? { parts: square, radius: 57 } as never : null) };
    keys.set(7, 'swarm-7');
    const hit = h.hitscan(0, 0, 0, 1, 500, 'me');
    expect(hit?.hitId).toBe('swarm-7');
    expect(hit!.dist).toBeCloseTo(210, 0);
    w.dispose();
  });

  it('the closest of predWorld and drawn hits wins', async () => {
    const { w, h, swarm } = await setup();
    swarm.get(1)!.y = 600; // drawn behind the asteroid
    expect(h.hitscan(0, 0, 0, 1, 800, 'me')?.hitId).toBe('swarm-9');
    w.dispose();
  });
});
