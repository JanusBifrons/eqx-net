/**
 * Macro terrain C5h (#13, #15): the link PREVIEW's obstacles must include the
 * cut-field rocks sleeping in a loaded chunk. Those rocks are drawn by the
 * renderer's `CutFieldLayer` (chunk mesh) but are not swarm records, so before
 * this the preview (`asteroidObstaclesFromSwarm`, swarm only) drew a link as
 * clear that the server, which adds dormant rocks over the link's box
 * (`CutFieldSubsystem.dormantObstacles` via `fieldRocksInBox`), refuses.
 *
 * The oracle is the server's own recipe: `fieldRocksInBox` + `fieldRockBody` +
 * `rockObstacleParts`, at rest, consumed rocks gone, moved rocks at their pose.
 */
import { describe, it, expect, vi } from 'vitest';

// A GL program needs a canvas; node has none.
vi.mock('../render/field/fieldRockShader', () => ({
  fieldRockProgram: () => ({}),
  fieldRockBatchProgram: () => ({}),
  fieldRockShaderResources: () => ({}),
  setFieldRockView: () => {},
  setFieldOreStyle: () => {},
}));
import { CutFieldLayer } from '../render/field/CutFieldLayer';
import { asteroidObstaclesFromSwarm, RESTING_BOX_SNAP, RockObstacleShapes } from './mirrorToGridNode.js';
import { rockObstacleParts, type GridObstacle, type ObstacleBox } from '../../core/structures/Grid.js';
import type { SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { cutFieldOpts, fieldRockBody, fieldRocksInBox } from '../../core/terrain/chunkStreamer.js';
import { rocksInChunk } from '../../core/terrain/fieldLayout.js';
import { collapsePackedRock, packChunk, type PackedChunk } from '../../core/terrain/packedChunk.js';

const o = cutFieldOpts('look');
// The `cut-field-test` room's chunk (rocks for sure), and its neighbours, so
// a rock reaching in from next door is loaded too.
const CX = -8, CY = 6;
const packed = new Map<string, PackedChunk>();
for (let cx = CX - 1; cx <= CX + 1; cx++) for (let cy = CY - 1; cy <= CY + 1; cy++) {
  packed.set(`${cx},${cy}`, packChunk(rocksInChunk(o, cx, cy), o.seed));
}
const home = packed.get(`${CX},${CY}`)!;
// The biggest rock of the home chunk.
let bigIdx = 0;
for (let r = 1; r < home.keys.length; r++) if (home.bodies[r * 3 + 2]! > home.bodies[bigIdx * 3 + 2]!) bigIdx = r;
const bigKey = home.keys[bigIdx]!;
const bx = home.bodies[bigIdx * 3]!, by = home.bodies[bigIdx * 3 + 1]!;
// On the preview's snap grid, so the server's box and the scanned one agree.
const S = RESTING_BOX_SNAP;
const box: ObstacleBox = {
  x0: Math.floor((bx - 60) / S) * S, y0: Math.floor((by - 60) / S) * S,
  x1: Math.ceil((bx + 60) / S) * S, y1: Math.ceil((by + 60) / S) * S,
};

function loadedLayer(moved?: Float64Array, consumedIdx?: number): CutFieldLayer {
  const layer = new CutFieldLayer();
  for (const [ck, c] of packed) {
    const [cx, cy] = ck.split(',').map(Number) as [number, number];
    if (cx === CX && cy === CY) {
      const copy: PackedChunk = { ...c, outlines: c.outlines.slice() };
      if (consumedIdx !== undefined) collapsePackedRock(copy, consumedIdx);
      layer.setChunk(cx, cy, copy.outlines, copy.ore, copy, moved ?? null);
    } else {
      layer.setChunk(cx, cy, c.outlines, c.ore, c, null);
    }
  }
  return layer;
}

function shapesOver(layer: CutFieldLayer): RockObstacleShapes {
  const s = new RockObstacleShapes();
  s.fieldRocks = layer;
  return s;
}

/** What the server adds for the box (`dormantObstacles`, nothing loaded). */
function serverObstacles(): GridObstacle[] {
  return fieldRocksInBox(o, box.x0, box.y0, box.x1, box.y1).map((r) => {
    const b = fieldRockBody(r);
    return { x: r.x, y: r.y, radius: r.radius, angle: 0, parts: rockObstacleParts(b.verts, b.parts, true) };
  });
}

const sorted = (a: GridObstacle[]): GridObstacle[] => [...a].sort((p, q) => p.x - q.x || p.y - q.y);
const plain = (a: GridObstacle[]): GridObstacle[] =>
  sorted(a.map((g) => ({ x: g.x, y: g.y, radius: g.radius, angle: g.angle ?? 0, parts: g.parts })));

function swarmRock(key: number, x: number, y: number, radius: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0.3, angvel: 0, prevX: x, prevY: y, prevAngle: 0.3,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0, radius, kind: 0,
    sleeping: false, lastUpdateTick: 0, fieldKey: key,
  };
}

describe('link preview sees field rocks sleeping in a loaded chunk (C5h)', () => {
  it('a rock off the swarm wire is an obstacle, as the server builds it', () => {
    const want = serverObstacles();
    expect(want.length, 'the box holds a field rock').toBeGreaterThan(0);
    const got = asteroidObstaclesFromSwarm(new Map(), [], shapesOver(loadedLayer()), box);
    expect(plain(got)).toEqual(plain(want));
  });

  it('a rock on the swarm wire counts once, at its wire pose', () => {
    const swarm = new Map([[1, swarmRock(bigKey, bx + 5, by + 5, home.bodies[bigIdx * 3 + 2]!)]]);
    const got = asteroidObstaclesFromSwarm(swarm, [], shapesOver(loadedLayer()), box);
    expect(got.filter((g) => g.x === bx && g.y === by)).toHaveLength(0);
    expect(got.filter((g) => g.x === bx + 5 && g.y === by + 5)).toHaveLength(1);
    expect(got).toHaveLength(serverObstacles().length);
  });

  it('a consumed rock is gone', () => {
    const got = asteroidObstaclesFromSwarm(new Map(), [], shapesOver(loadedLayer(undefined, bigIdx)), box);
    expect(got.some((g) => g.x === bx && g.y === by)).toBe(false);
    expect(got).toHaveLength(serverObstacles().length - 1);
  });

  it('a moved rock is at its moved pose and angle', () => {
    const moved = new Float64Array([bigIdx, bx + 20, by - 10, 0.7]);
    const got = asteroidObstaclesFromSwarm(new Map(), [], shapesOver(loadedLayer(moved)), box);
    const hit = got.find((g) => g.x === bx + 20 && g.y === by - 10);
    expect(hit, 'the moved rock').toBeDefined();
    expect(hit!.angle).toBe(0.7);
    expect(got.some((g) => g.x === bx && g.y === by)).toBe(false);
  });

  it('caches per box: the same box rescans nothing, reuses the obstacles (#14)', () => {
    const layer = loadedLayer();
    const spy = vi.spyOn(layer, 'restingRocksInBox');
    const s = shapesOver(layer), out: GridObstacle[] = [];
    asteroidObstaclesFromSwarm(new Map(), out, s, box);
    const first = out[0];
    asteroidObstaclesFromSwarm(new Map(), out, s, box);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out[0]).toBe(first);
    // A chunk change invalidates it.
    layer.setChunk(CX + 5, CY + 5, null);
    asteroidObstaclesFromSwarm(new Map(), out, s, box);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
