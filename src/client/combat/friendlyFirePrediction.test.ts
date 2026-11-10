/**
 * Friendly fire (owner decision 2026-11-10: every shot hits whatever it meets,
 * the shooter's own side included). The server's player beam already stops
 * on the first thing in its path (`PlayerFireResolver.hitscan`, no side
 * filter). The client's local beam end and optimistic hit prediction must
 * agree (#15): they stop on an ALLY in the path (the pilot's own structure,
 * another player's ship), never pass through it to the enemy behind.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { DisplayPoseHitscan } from './displayPoseHitscan.js';
import { resolveClosestPredictedHit } from './HitPrediction.client.js';

beforeAll(async () => {
  await RAPIER.init();
});

function drone(x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 12, kind: 1, shipKind: 'fighter', shieldDown: false,
    sleeping: false, lastUpdateTick: 0, prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0,
    latestArrivalMs: 0, poseRing: [], ringHead: 0,
  } as unknown as SwarmRenderState;
}

/** Me at the origin facing +y; an enemy drone DRAWN at (0, 300). */
async function setup(ally: 'structure' | 'player'): Promise<{ w: PhysicsWorld; h: DisplayPoseHitscan }> {
  const w = await PhysicsWorld.create();
  w.spawnShip('me', 0, 0);
  if (ally === 'structure') {
    // My own structure (a static swarm body, kind 2) halfway along the line.
    w.spawnObstacle('swarm-5', 0, 150, 30, 3);
    w.lockBody('swarm-5');
  } else {
    // A friendly pilot's ship halfway along the line.
    w.spawnShip('friend', 0, 150);
  }
  w.spawnObstacle('swarm-1', 60, 300, 12, 3); // the enemy's (leading) body
  w.tick(1 / 60);
  const h = new DisplayPoseHitscan(new Set(['swarm-1']), new Map([[1, 'swarm-1'], [5, 'swarm-5']]));
  h.world = w;
  h.swarm = new Map([[1, drone(0, 300)]]);
  return { w, h };
}

describe('client prediction — friendly fire', () => {
  for (const ally of ['structure', 'player'] as const) {
    it(`the local beam ends on an allied ${ally} in the path, not the enemy behind`, async () => {
      const { w, h } = await setup(ally);
      const hit = h.hitscan(0, 0, 0, 1, 500, 'me');
      expect(hit?.hitId).toBe(ally === 'structure' ? 'swarm-5' : 'friend');
      expect(hit!.dist).toBeLessThan(150);
      w.dispose();
    });

    it(`the optimistic hit prediction lands on an allied ${ally} in the path`, async () => {
      const { w, h } = await setup(ally);
      const best = resolveClosestPredictedHit(h, [{ fromX: 0, fromY: 20, fwdX: 0, fwdY: 1 }], 500, 'me');
      expect(best?.hitId).toBe(ally === 'structure' ? 'swarm-5' : 'friend');
      w.dispose();
    });
  }
});
