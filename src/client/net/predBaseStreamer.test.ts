/**
 * PredBaseStreamer locks (plan: soft-leaping-truffle, PR-V2).
 *  - chunks within PREDWORLD_ACTIVE_RADIUS of the ship are instantiated,
 *    farther ones are not, and they stream as the ship moves;
 *  - the active set stays inside MAX_CLIENT_ACTIVE_PIECES (client replay budget);
 *  - a base that leaves room state is torn down (sector handoff);
 *  - the client collider geometry is the SAME as the server worker's
 *    (both call buildChunkOutlines on the same descriptor) — a ship stops at
 *    the same wall in either world.
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../../core/physics/World.js';
import { PredBaseStreamer, type BaseStateView } from './predBaseStreamer.js';
import { BASE_GENERATOR_VERSION } from '../../core/procgen/baseLayout.js';
import { generateBase } from '../../core/procgen/generateBase.js';
import { buildChunkOutlines, chunkCount } from '../../core/procgen/baseChunkMesh.js';
import { MAX_CLIENT_ACTIVE_PIECES, PREDWORLD_ACTIVE_RADIUS } from '../../shared-types/baseBudgets.js';

const VIEW: BaseStateView = { ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed: 42, originX: 0, originY: 0, size: 8000 };

function states(entries: Array<[string, BaseStateView]>) {
  const m = new Map(entries);
  return { forEach: (cb: (v: BaseStateView, k: string) => void) => m.forEach((v, k) => cb(v, k)) };
}

describe('PredBaseStreamer', () => {
  it('instantiates only chunks near the ship, and streams as it moves', async () => {
    const world = await PhysicsWorld.create();
    const s = new PredBaseStreamer();
    const half = generateBase({ ver: VIEW.ver, archetype: 'warehouse', seed: VIEW.seed, x: 0, y: 0, size: VIEW.size }).half;
    // Far outside the base: nothing.
    s.sync(world, states([['b0', VIEW]]), 0, -half - PREDWORLD_ACTIVE_RADIUS - 500);
    expect(s.activeChunkCount()).toBe(0);
    // At the south wall: some chunks, not all.
    s.sync(world, states([['b0', VIEW]]), 0, -half);
    const near = s.activeChunkCount();
    expect(near).toBeGreaterThan(0);
    // Centre of the base: a different set.
    s.sync(world, states([['b0', VIEW]]), 0, 0);
    const centre = s.activeChunkCount();
    expect(centre).toBeGreaterThan(0);
    expect(world.baseChunkBodyCount()).toBeLessThanOrEqual(centre);
  });

  it('keeps the active piece count inside MAX_CLIENT_ACTIVE_PIECES anywhere in the base', async () => {
    const world = await PhysicsWorld.create();
    const s = new PredBaseStreamer();
    const l = generateBase({ ver: VIEW.ver, archetype: 'warehouse', seed: VIEW.seed, x: 0, y: 0, size: VIEW.size });
    const piecesPerChunk = new Uint32Array(chunkCount(l));
    for (let i = 0; i < l.count; i++) piecesPerChunk[l.chunk[i]!]!++;
    for (let y = -l.half; y <= l.half; y += 700) {
      for (let x = -l.half; x <= l.half; x += 700) {
        s.sync(world, states([['b0', VIEW]]), x, y);
        let pieces = 0;
        const b = s.layouts().get('b0')!;
        for (let c = 0; c < b.active.length; c++) if (b.active[c]) pieces += piecesPerChunk[c]!;
        expect(pieces).toBeLessThanOrEqual(MAX_CLIENT_ACTIVE_PIECES);
      }
    }
  });

  it('tears a base down when it leaves room state', async () => {
    const world = await PhysicsWorld.create();
    const s = new PredBaseStreamer();
    s.sync(world, states([['b0', VIEW]]), 0, 0);
    expect(world.baseChunkBodyCount()).toBeGreaterThan(0);
    s.sync(world, states([]), 0, 0);
    expect(world.baseChunkBodyCount()).toBe(0);
    expect(s.layouts().size).toBe(0);
  });

  it('client and server-style worlds stop a ship at the same wall', async () => {
    const l = generateBase({ ver: VIEW.ver, archetype: 'warehouse', seed: VIEW.seed, x: 0, y: 0, size: VIEW.size });
    // Server-style: every chunk, as the worker's SPAWN_BASE does.
    const server = await PhysicsWorld.create();
    const outlines = buildChunkOutlines(l);
    for (let c = 0; c < outlines.length; c++) server.spawnBaseChunk('b0', c, outlines[c]!.vertices, outlines[c]!.indices);
    // Client: streamed around the approach point.
    const client = await PhysicsWorld.create();
    const s = new PredBaseStreamer();
    const y0 = -l.half - 400;
    s.sync(client, states([['b0', VIEW]]), 0, y0);
    const run = (w: PhysicsWorld): number => {
      w.spawnShip('s', 37, y0, 'scout');
      w.tick(1 / 60);
      w.setShipState('s', { x: 37, y: y0, angle: 0, vx: 0, vy: 800, angvel: 0 });
      for (let t = 0; t < 90; t++) w.tick(1 / 60);
      return w.getShipState('s')!.y;
    };
    const ys = run(server);
    const yc = run(client);
    expect(Math.abs(ys - yc)).toBeLessThan(0.5);
  });
});
