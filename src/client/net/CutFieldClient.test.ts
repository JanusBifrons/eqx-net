import { describe, it, expect, afterEach } from 'vitest';
import type { PhysicsWorld } from '@core/physics/World';
import { CHUNK_SIZE } from '@core/terrain/fieldLayout';
import { PREDWORLD_STRUCTURE_RADIUS, PREDWORLD_STRUCTURE_HYSTERESIS } from '../../shared-types/structureBudgets.js';
import { CutFieldClient } from './CutFieldClient.js';

/** A predWorld that records bodies (the client module only spawns, locks,
 *  despawns). */
function fakePredWorld() {
  const bodies = new Map<string, { x: number; y: number; radius: number; verts: number; locked: boolean }>();
  const pw = {
    spawnObstacle: (id: string, x: number, y: number, radius: number, _m: number, verts: unknown[]) => {
      bodies.set(id, { x, y, radius, verts: verts.length, locked: false });
    },
    lockBody: (id: string) => { const b = bodies.get(id); if (b) b.locked = true; },
    fixBody: (id: string) => { const b = bodies.get(id); if (b) b.locked = true; },
    despawnShip: (id: string) => { bodies.delete(id); },
  };
  return { pw: pw as unknown as PhysicsWorld, bodies };
}

function rig() {
  const { pw, bodies } = fakePredWorld();
  const pose = { x: 0, y: 0 };
  const drawn = new Map<string, Float32Array>();
  const c = new CutFieldClient({
    gameClock: { now: () => 0 },
    predWorld: () => pw,
    localPose: () => pose,
    draw: {
      setFieldChunk: (cx, cy, outlines) => {
        if (outlines) drawn.set(`${cx},${cy}`, outlines); else drawn.delete(`${cx},${cy}`);
      },
    },
  });
  return { c, pose, bodies, drawn };
}

let live: CutFieldClient | null = null;
afterEach(() => { live?.stop(); live = null; });

describe('CutFieldClient (macro terrain v2, slice 2)', () => {
  it('cuts one chunk per step, the ship\'s own chunk first, and draws it', () => {
    const { c, pose, drawn } = rig();
    live = c;
    // A spot in the field ring (the middle is a hole): 60 km out.
    pose.x = 60_000; pose.y = 0;
    c.setSeed('test-seed');
    c.step();
    expect(c.chunksLoaded).toBe(1);
    const own = `${Math.floor(pose.x / CHUNK_SIZE)},${Math.floor(pose.y / CHUNK_SIZE)}`;
    expect([...drawn.keys()]).toEqual([own]);
    for (let i = 0; i < 60; i++) c.step();
    expect(c.chunksLoaded).toBe(49); // 7×7 around the ship
    expect(drawn.size).toBe(49);
  });

  it('gives predWorld only the rocks the ship can touch, locked', () => {
    const { c, pose, bodies } = rig();
    live = c;
    pose.x = 60_000; pose.y = 0;
    c.setSeed('test-seed');
    for (let i = 0; i < 60; i++) c.step();
    expect(c.loadedRocks).toBeGreaterThan(bodies.size);
    expect(bodies.size).toBeGreaterThan(0);
    for (const [id, b] of bodies) {
      expect(id.startsWith('field:')).toBe(true);
      expect(b.locked).toBe(true);
      const edge = Math.hypot(b.x - pose.x, b.y - pose.y) - b.radius;
      expect(edge).toBeLessThanOrEqual(PREDWORLD_STRUCTURE_RADIUS + PREDWORLD_STRUCTURE_HYSTERESIS);
    }
    expect(c.stats.predBodies).toBe(bodies.size);
  });

  it('drops every chunk and body on stop (sector change)', () => {
    const { c, pose, bodies, drawn } = rig();
    pose.x = 60_000; pose.y = 0;
    c.setSeed('test-seed');
    for (let i = 0; i < 10; i++) c.step();
    expect(drawn.size).toBeGreaterThan(0);
    c.stop();
    expect(drawn.size).toBe(0);
    expect(bodies.size).toBe(0);
    expect(c.loadedRocks).toBe(0);
  });
});
