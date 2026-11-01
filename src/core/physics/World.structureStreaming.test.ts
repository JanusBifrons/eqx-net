/**
 * A3 (plan soft-leaping-truffle v2) — why the client prediction world streams
 * structures by distance (PREDWORLD_STRUCTURE_RADIUS). Every server correction
 * replays ~20 ticks over everything in the prediction world; a whole citadel
 * makes that replay ~15× dearer. This test prints the replay cost with the
 * whole base vs only the structures near the ship (the measurement behind the
 * budget) and locks the deterministic part: near a citadel's centre only a
 * small fraction of it is in range.
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './World.js';
import { buildStructureLattice } from '../structures/structureLattice.js';
import { structureHullPoints, getStructureKind } from '../../shared-types/structureKinds.js';
import { gateColliderPolygons } from '../structures/gateGeometry.js';
import { PREDWORLD_STRUCTURE_RADIUS } from '../../shared-types/structureBudgets.js';

const SHIP_X = 200;
const SHIP_Y = 200;

async function replayMs(limit: number): Promise<{ median: number; p95: number; bodies: number }> {
  const w = await PhysicsWorld.create();
  const lat = buildStructureLattice({ n: 400, seed: 7, fence: true });
  let bodies = 0;
  lat.placements.forEach((p, i) => {
    const r = getStructureKind(p.kind).radius;
    if (Math.hypot(p.x - SHIP_X, p.y - SHIP_Y) - r > limit) return;
    const id = 'swarm-' + i;
    w.spawnObstacle(id, p.x, p.y, r, 3, structureHullPoints(p.kind), 0, undefined, gateColliderPolygons(p.kind) ?? undefined);
    w.lockBody(id);
    bodies++;
  });
  w.spawnShip('me', SHIP_X, SHIP_Y);
  for (let i = 0; i < 60; i++) w.tick(1 / 60);
  const t: number[] = [];
  for (let k = 0; k < 40; k++) {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      w.applyInput('me', { thrust: true, turnLeft: false, turnRight: false });
      w.tick(1 / 60);
    }
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return { median: t[20]!, p95: t[38]!, bodies };
}

describe('prediction world structure streaming (A3)', () => {
  it('only a fraction of a citadel is within the streaming radius; replay cost printed', async () => {
    const all = await replayMs(Infinity);
    const near = await replayMs(PREDWORLD_STRUCTURE_RADIUS);
    // eslint-disable-next-line no-console
    console.log(
      `20-tick replay — whole citadel (${all.bodies} bodies): median ${all.median.toFixed(2)} ms, p95 ${all.p95.toFixed(2)} ms; ` +
      `within ${PREDWORLD_STRUCTURE_RADIUS} u (${near.bodies} bodies): median ${near.median.toFixed(2)} ms, p95 ${near.p95.toFixed(2)} ms`,
    );
    expect(all.bodies).toBeGreaterThan(400);
    expect(near.bodies).toBeLessThan(all.bodies / 5);
  }, 60_000);
});
