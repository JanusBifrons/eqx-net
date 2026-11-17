/**
 * The cut field follows the camera too (owner phone play test: in the command
 * view, panned ~40 km from the ship, the rocks "petered out like a hard
 * stop"). The client streams around the own ship (collision) AND the camera
 * centre the renderer feeds back (`RendererFeedback.viewX/viewY/viewHalf`),
 * with a ring sized to the view and capped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { PhysicsWorld } from '@core/physics/World';
import { CHUNK_SIZE } from '@core/terrain/fieldLayout';
import { CAMERA_MAX_RINGS, CutFieldClient, cameraRings } from './CutFieldClient.js';

function rig() {
  const bodies = new Map<string, { x: number; y: number }>();
  const pw = {
    spawnObstacle: (id: string, x: number, y: number) => { bodies.set(id, { x, y }); },
    fixBody: () => {},
    despawnShip: (id: string) => { bodies.delete(id); },
  } as unknown as PhysicsWorld;
  const pose = { x: 60_000, y: 0 };
  const drawn: string[] = [];
  const c = new CutFieldClient({
    gameClock: { now: () => 0 },
    predWorld: () => pw,
    localPose: () => pose,
    draw: { setFieldChunk: (cx, cy, outlines) => { if (outlines) drawn.push(`${cx},${cy}`); } },
  });
  return { c, pose, drawn, bodies };
}

const chunkOf = (x: number, y: number): [number, number] => [Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)];
/** Every chunk key within Chebyshev `r` of the point's chunk. */
function ringKeys(x: number, y: number, r: number): string[] {
  const [cx, cy] = chunkOf(x, y);
  const out: string[] = [];
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) out.push(`${cx + dx},${cy + dy}`);
  return out;
}

let live: CutFieldClient | null = null;
afterEach(() => { live?.stop(); live = null; });

describe('CutFieldClient follows the camera (command view)', () => {
  it('loads the chunks around a camera 40 km from the ship, as well as the ship\'s', () => {
    const { c, pose, drawn, bodies } = rig();
    live = c;
    const B = { x: pose.x, y: 40_000 };
    c.setSeed('test-seed');
    c.setView(B.x, B.y, 2_800); // a phone at the fighter zoom-out floor
    for (let i = 0; i < 120; i++) c.step();
    const have = new Set(drawn);
    for (const k of ringKeys(B.x, B.y, 3)) expect(have.has(k), `camera chunk ${k}`).toBe(true);
    for (const k of ringKeys(pose.x, pose.y, 3)) expect(have.has(k), `ship chunk ${k}`).toBe(true);
    expect(c.chunksLoaded).toBe(98); // two disjoint 7×7 rings
    // predWorld bodies stay near the ship only.
    expect(bodies.size).toBeGreaterThan(0);
    for (const b of bodies.values()) expect(Math.hypot(b.x - pose.x, b.y - pose.y)).toBeLessThan(10_000);
  });

  it('cuts nearest the camera first once the ship\'s ring is in', () => {
    const { c, pose, drawn } = rig();
    live = c;
    c.setSeed('test-seed');
    for (let i = 0; i < 49; i++) c.step(); // the ship's 7×7
    expect(c.chunksLoaded).toBe(49);
    drawn.length = 0;
    c.setView(pose.x, 40_000, 2_800);
    c.step();
    expect(drawn).toEqual([chunkOf(pose.x, 40_000).join(',')]);
  });

  it('without a view (no frame yet) streams around the ship only', () => {
    const { c } = rig();
    live = c;
    c.setSeed('test-seed');
    c.setView(0, 0, 0);
    for (let i = 0; i < 80; i++) c.step();
    expect(c.chunksLoaded).toBe(49);
  });

  it('sizes the ring from the zoom, capped', () => {
    expect(cameraRings(0)).toBe(0); // no view
    expect(cameraRings(2_800)).toBe(3); // never under the ship's 7×7
    expect(cameraRings(4 * CHUNK_SIZE)).toBe(5); // half-view in chunks + 1 margin
    expect(cameraRings(20_000)).toBe(6);
    expect(cameraRings(92_000)).toBe(CAMERA_MAX_RINGS); // a battleship's floor on a phone
    expect(cameraRings(Infinity)).toBe(CAMERA_MAX_RINGS);
  });

  it('a far zoom loads the capped ring around the camera, and no more', () => {
    const { c, pose } = rig();
    live = c;
    c.setSeed('test-seed');
    c.setView(pose.x, pose.y, 92_000);
    const side = 2 * CAMERA_MAX_RINGS + 1;
    for (let i = 0; i < side * side + 20; i++) c.step();
    expect(c.chunksLoaded).toBe(side * side);
  });
});
