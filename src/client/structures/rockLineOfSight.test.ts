/**
 * Macro terrain C5c, the client half (#15): the connection-range PREVIEW must
 * judge a rock's line of sight on the same shape the server does, its convex
 * parts at its angle (`rockObstacleParts`), not its bounding box. Before this
 * the preview's rocks were `{x, y, radius}` only, so a link the server makes
 * (the line clears the rock's outline) drew red.
 *
 * The client's shape per rock comes from `RockObstacleShapes`: an awake field
 * rock's cut body (the renderer's `CutFieldLayer.rockBody`, packed by the
 * client's cutter), an ordinary asteroid's seeded outline.
 */
import { describe, it, expect } from 'vitest';
import { asteroidObstaclesFromSwarm, RockObstacleShapes } from './mirrorToGridNode.js';
import { isConnectionLineBlocked, rockObstacleParts, type GridNode, type GridObstacle } from '../../core/structures/Grid.js';
import type { SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { fieldRockBody, type FieldRockBody } from '../../core/terrain/chunkStreamer.js';
import { asteroidShapeSeed, generateAsteroidVertices } from '../../core/swarm/asteroidShape.js';

function entry(x: number, y: number, radius: number, angle: number, over: Partial<SwarmRenderState> = {}): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle, angvel: 0, prevX: x, prevY: y, prevAngle: angle,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0, radius, kind: 0,
    sleeping: true, lastUpdateTick: 0, ...over,
  };
}

function shapes(bodies: Map<number, FieldRockBody> = new Map()): RockObstacleShapes {
  const s = new RockObstacleShapes();
  s.fieldRocks = { rockBody: (k) => bodies.get(k) ?? null };
  return s;
}

function node(id: string, x: number, y: number): GridNode {
  return { id, x, y, radius: 10, isHub: true, isCapital: false, maxConnections: 4, powerOutput: 0, powerConsumption: 0, isConstructed: true };
}

const blocked = (rock: SwarmRenderState, s: RockObstacleShapes, a: GridNode, b: GridNode): boolean =>
  isConnectionLineBlocked(a, b, new Map(), asteroidObstaclesFromSwarm(new Map([[1, rock]]), [], s));

/** A long thin field rock: 2000 wide, 40 tall (bounding radius ~1000). */
const SLAB = [{ x: -1000, y: -20 }, { x: 1000, y: -20 }, { x: 1000, y: 20 }, { x: -1000, y: 20 }];

describe('client link preview vs a rock (C5c, #15)', () => {
  it('a line through the rock\'s circle but clear of its outline is NOT blocked', () => {
    const body = fieldRockBody({ verts: SLAB });
    const rock = entry(0, 0, body.radius, 0, { fieldKey: 7 });
    const s = shapes(new Map([[7, body]]));
    // y = 500 crosses the ~1000-radius circle (and its box) but not the slab.
    expect(blocked(rock, s, node('a', -1500, 500), node('b', 1500, 500))).toBe(false);
    // Straight through the slab is still blocked.
    expect(blocked(rock, s, node('a', -1500, 0), node('b', 1500, 0))).toBe(true);
  });

  it('uses the rock\'s angle: the slab turned a quarter blocks the level line, not one beside it', () => {
    const body = fieldRockBody({ verts: SLAB });
    const rock = entry(0, 0, body.radius, Math.PI / 2, { fieldKey: 7 });
    const s = shapes(new Map([[7, body]]));
    expect(blocked(rock, s, node('a', -1500, 500), node('b', 1500, 500))).toBe(true);
    expect(blocked(rock, s, node('a', 500, -1500), node('b', 500, 1500))).toBe(false);
  });

  it('an ordinary asteroid: a line across its box corner, clear of its outline, is NOT blocked', () => {
    const r = 400;
    const rock = entry(0, 0, r, 0, { shapeSeed: 1234 });
    // x + y = 1.6r crosses the box corner; the outline (inside the circle)
    // reaches at most x + y = r√2.
    expect(blocked(rock, shapes(), node('a', 2 * r, -0.4 * r), node('b', -0.4 * r, 2 * r))).toBe(false);
  });

  it('a field rock whose chunk this client has not loaded stays the box (never a false green)', () => {
    const rock = entry(0, 0, 1000, 0, { fieldKey: 9 });
    expect(blocked(rock, shapes(), node('a', -1500, 500), node('b', 1500, 500))).toBe(true);
  });

  it('builds a rock\'s parts once and reuses them (#14: no per-frame allocation)', () => {
    const rock = entry(0, 0, 300, 0, { shapeSeed: 77 });
    const s = shapes();
    const first = s.partsFor(rock);
    expect(s.partsFor({ ...rock, x: 5 })).toBe(first); // a fresh entry (worker clone), same rock
    expect(s.partsFor({ ...rock, radius: 301 })).not.toBe(first); // a different rock
  });
});

describe('client rock obstacle == server rock obstacle (contract, #15)', () => {
  // The server's record fields as `SwarmSpawner.spawnAsteroid` sets them
  // (`vertices`, `wreckParts` = the field body's parts, `fieldRock`) and as
  // `SectorRoom.gatherStructureObstacles` reads them (x/y/angle from the SAB).
  const serverObstacle = (
    rec: { vertices?: { x: number; y: number }[]; wreckParts?: { x: number; y: number }[][]; fieldRock?: boolean },
    x: number, y: number, radius: number, angle: number,
  ): GridObstacle => ({ x, y, radius, angle, parts: rockObstacleParts(rec.vertices, rec.wreckParts, rec.fieldRock === true) });

  const clientObstacle = (rock: SwarmRenderState, s: RockObstacleShapes): GridObstacle =>
    asteroidObstaclesFromSwarm(new Map([[1, rock]]), [], s)[0]!;

  it('a dented field rock: same parts and angle', () => {
    const body = fieldRockBody({ verts: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 500 }, { x: 300, y: 150 }, { x: 0, y: 500 }] });
    expect(body.parts).not.toBeNull();
    expect(body.parts!.length).toBeGreaterThan(1); // really dented: not one hull
    const rock = entry(body.x, body.y, body.radius, 0.3, { fieldKey: 3 });
    expect(clientObstacle(rock, shapes(new Map([[3, body]]))))
      .toEqual(serverObstacle({ vertices: body.verts, wreckParts: body.parts!, fieldRock: true }, body.x, body.y, body.radius, 0.3));
  });

  it('a field rock with no parts (crossed outline): both use its convex hull', () => {
    const body: FieldRockBody = { ...fieldRockBody({ verts: SLAB }), parts: null };
    const rock = entry(0, 0, body.radius, 0, { fieldKey: 4 });
    expect(clientObstacle(rock, shapes(new Map([[4, body]]))))
      .toEqual(serverObstacle({ vertices: body.verts, fieldRock: true }, 0, 0, body.radius, 0));
  });

  it('an ordinary asteroid: the seeded outline from the stable id', () => {
    const seed = asteroidShapeSeed('asteroid-42');
    const rock = entry(50, -70, 300, 1.1, { shapeSeed: seed });
    expect(clientObstacle(rock, shapes()))
      .toEqual(serverObstacle({ vertices: generateAsteroidVertices(seed, 300) }, 50, -70, 300, 1.1));
  });
});
