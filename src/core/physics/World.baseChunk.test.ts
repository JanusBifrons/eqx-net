/**
 * Procedural-base chunk physics (plan: soft-leaping-truffle, PR-V).
 *
 * Drives REAL base geometry through the shared `buildChunkOutlines` →
 * `World.spawnBaseChunk` path (the same code the server worker and the client
 * predWorld run):
 *  - a ship flying into a generated perimeter wall is stopped;
 *  - a ship pressed against a row of ADJACENT pieces and sliding along it does
 *    not snag on the seams (the reason colliders are union OUTLINES — measured:
 *    trimesh 340, cuboids 215, outline 565 vs a damping-only 565);
 *  - a predicted hitscan resolves a base hit to its static sentinel id;
 *  - removing chunks makes the space passable again (client streaming / rebuild);
 *  - the outline merges adjacent pieces and never breaks at a chunk line.
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './World.js';
import { generateBase } from '../procgen/generateBase.js';
import { BASE_GENERATOR_VERSION, LayoutBuilder, type BaseDescriptor, type BaseLayout } from '../procgen/baseLayout.js';
import { baseOutlineSegments, buildChunkOutlines, chunkCount } from '../procgen/baseChunkMesh.js';
import { basePieceIndex } from '../../shared-types/basePieceKinds.js';

const HZ = 60;
const TEST_DESC: BaseDescriptor = { ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed: 0, x: 0, y: 0, size: 8192 };

function spawnAll(world: PhysicsWorld, id: string, l: BaseLayout): void {
  const outlines = buildChunkOutlines(l);
  for (let c = 0; c < outlines.length; c++) world.spawnBaseChunk(id, c, outlines[c]!.vertices, outlines[c]!.indices);
}

/** One long row of N ADJACENT 200×64 wall pieces along y ∈ [0, 64). */
function seamRow(n: number): BaseLayout {
  const b = new LayoutBuilder(4096);
  const wall = basePieceIndex('wall');
  for (let i = 0; i < n; i++) b.addRect(wall, -n * 100 + i * 200, 0, -n * 100 + (i + 1) * 200, 64);
  return b.build(TEST_DESC, 0);
}

describe('base chunks — physics', () => {
  it('stops a ship flying head-on into a generated perimeter wall', async () => {
    const world = await PhysicsWorld.create();
    const l = generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed: 7, x: 0, y: 0, size: 5000 });
    spawnAll(world, 'b1', l);
    // Approach the LEFT wall from outside at a y well clear of any left gate.
    let y = 0;
    for (let g = 0; g < l.gates.length; g += 2) {
      if (l.gates[g] === -l.half && Math.abs(l.gates[g + 1]!) < 800) y = l.gates[g + 1]! > 0 ? -1200 : 1200;
    }
    const A = -Math.PI / 2; // nose along +x
    world.spawnShip('s', -l.half - 300, y, 'scout');
    world.tick(1 / HZ);
    world.setShipState('s', { x: -l.half - 300, y, angle: A, vx: 900, vy: 0, angvel: 0 });
    for (let t = 0; t < 90; t++) world.tick(1 / HZ);
    expect(world.getShipState('s')!.x).toBeLessThan(-l.half);
  });

  it('a ship sliding along a row of adjacent pieces keeps its speed (no seam snag)', async () => {
    const world = await PhysicsWorld.create();
    spawnAll(world, 'row', seamRow(30));
    // Nose along +x (angle -π/2: forward = (-sin θ, cos θ)) so the car-model
    // lateral grip doesn't eat the slide; pressed DOWN onto the row's top face
    // while sliding across ~15 seams. A snag shows as a vx collapse.
    const A = -Math.PI / 2;
    world.spawnShip('s', -2400, 64 + 12, 'scout');
    world.tick(1 / HZ);
    let minVx = Infinity;
    for (let t = 0; t < 300; t++) {
      const st = world.getShipState('s')!;
      world.setShipState('s', { ...st, angle: A, vx: 600, vy: -120, angvel: 0 });
      world.tick(1 / HZ);
      const after = world.getShipState('s')!;
      if (t > 10 && after.x < 2400) minVx = Math.min(minVx, after.vx);
      expect(after.y).toBeGreaterThan(64 - 4); // never pushed into the row
    }
    // Damping alone leaves ~565 (one seamless piece measured the same); a seam
    // snag drops it to ~215–340 (trimesh / cuboids, measured).
    expect(minVx).toBeGreaterThan(540);
  });

  it('a predicted hitscan stops at base geometry and resolves its static id', async () => {
    const world = await PhysicsWorld.create();
    spawnAll(world, 'row', seamRow(4));
    world.spawnShip('s', 0, -300, 'scout');
    world.tick(1 / HZ);
    const hit = world.hitscan(0, -300, 0, 1, 1000, 's');
    expect(hit?.hitId.startsWith('base-row-')).toBe(true);
    expect(hit!.dist).toBeGreaterThan(250);
    expect(hit!.dist).toBeLessThan(310);
  });

  it('removing every chunk makes the space passable again', async () => {
    const world = await PhysicsWorld.create();
    const l = seamRow(4);
    spawnAll(world, 'row', l);
    expect(world.baseChunkBodyCount()).toBeGreaterThan(0);
    for (let c = 0; c < chunkCount(l); c++) world.removeBaseChunk('row', c);
    expect(world.baseChunkBodyCount()).toBe(0);
    world.spawnShip('s', 0, -300, 'scout');
    world.tick(1 / HZ);
    world.setShipState('s', { x: 0, y: -300, angle: 0, vx: 0, vy: 900, angvel: 0 });
    for (let t = 0; t < 60; t++) world.tick(1 / HZ);
    expect(world.getShipState('s')!.y).toBeGreaterThan(64);
  });

  it('outline: adjacent pieces merge (no internal edges), floors are not colliders', () => {
    const b = new LayoutBuilder(4096);
    const wall = basePieceIndex('wall');
    b.addRect(wall, 0, 0, 200, 64);
    b.addRect(wall, 200, 0, 400, 64);
    b.addRect(basePieceIndex('loading_bay'), 1000, 1000, 1600, 1600);
    // Two adjacent 200×64 walls → ONE 400×64 outline = 4 segments, not 8; the
    // floor contributes none.
    expect(baseOutlineSegments(b.build(TEST_DESC, 0)).length / 4).toBe(4);
  });

  it('outline: a piece split at a chunk line stays ONE rectangle outline (no chunk seam)', () => {
    const b = new LayoutBuilder(4096);
    // x = 0 is a chunk line (half 4096 → lines at -4096 + k·1024).
    b.addRect(basePieceIndex('wall'), -512, 0, 512, 64);
    const l = b.build(TEST_DESC, 0);
    expect(l.count).toBe(2); // the builder split it
    expect(baseOutlineSegments(l).length / 4).toBe(4); // the outline did not
  });
});
