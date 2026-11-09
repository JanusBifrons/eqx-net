/**
 * Heap-delta lock (invariant #14) for the remote-entity paradigm's hot
 * paths: the per-snapshot drone/scrap anchor (`anchorRemoteSwarmBodies`,
 * 20 Hz × N entities) and the drawn-pose half of the local beam ray
 * (`rayHitsDrawnSwarmEntity`, per mount per frame × N entities).
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { SwarmRenderState, PoseRingEntry } from '../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../core/contracts/IRenderer.js';
import { anchorRemoteSwarmBodies } from './snapshotRemoteSync.js';
import { rayHitsDrawnSwarmEntity } from '../combat/displayPoseHitscan.js';

beforeAll(async () => {
  await RAPIER.init();
});

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`.');
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

function entry(kind: number, x: number, y: number): SwarmRenderState {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring.push({ x: x + i, y, angle: 0, vx: 60, vy: 0, angvel: 0.1, arrivalMs: i * 16, serverTick: 100 + i, sleeping: false, empty: false });
  }
  return {
    x, y, vx: 60, vy: 0, angle: 0, angvel: 0, radius: 12, kind, shipKind: 'fighter', componentIndex: 0,
    sleeping: false, lastUpdateTick: 100 + POSE_RING_DEPTH - 1, prevX: x, prevY: y, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: ring, ringHead: 0,
  } as unknown as SwarmRenderState;
}

describe('remote-entity paradigm heap-delta', () => {
  it('anchorRemoteSwarmBodies does not grow the heap', async () => {
    const w = await PhysicsWorld.create();
    const swarm = new Map<number, SwarmRenderState>();
    const keys = new Map<number, string>();
    for (let i = 0; i < 25; i++) {
      const key = `swarm-${i}`;
      w.spawnObstacle(key, i * 50, 0, 12, 3);
      swarm.set(i, entry(i % 2 === 0 ? 1 : 3, i * 50, 0));
      keys.set(i, key);
    }
    const scratch = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    for (let i = 0; i < 1000; i++) anchorRemoteSwarmBodies(w, swarm, 103, keys, scratch);
    const before = postGcHeap();
    for (let i = 0; i < 10_000; i++) anchorRemoteSwarmBodies(w, swarm, 103 + (i % 4), keys, scratch);
    const after = postGcHeap();
    expect(after - before).toBeLessThan(200_000);
    w.dispose();
  });

  it('rayHitsDrawnSwarmEntity does not grow the heap', () => {
    const d = entry(1, 0, 200);
    const dDown = entry(1, 0, 200);
    (dDown as { shieldDown?: boolean }).shieldDown = true;
    const s = entry(3, 0, 200);
    let sink = 0;
    for (let i = 0; i < 1000; i++) sink += rayHitsDrawnSwarmEntity(s, 0, 0, 0, 1, 500) ?? 0;
    const before = postGcHeap();
    for (let i = 0; i < 100_000; i++) {
      sink += rayHitsDrawnSwarmEntity(d, 0, 0, 0, 1, 500) ?? 0;
      sink += rayHitsDrawnSwarmEntity(dDown, 0, 0, 0, 1, 500) ?? 0;
      sink += rayHitsDrawnSwarmEntity(s, 0, 0, 0, 1, 500) ?? 0;
    }
    const after = postGcHeap();
    expect(sink).toBeGreaterThan(0);
    expect(after - before).toBeLessThan(200_000);
  });
});
