import { describe, it, expect, afterEach } from 'vitest';
import type { PhysicsWorld } from '@core/physics/World';
import { CHUNK_SIZE, rocksInChunk, type ChunkOpts } from '@core/terrain/fieldLayout';
import { packChunk, type PackedChunk } from '@core/terrain/packedChunk';
import { PREDWORLD_STRUCTURE_RADIUS, PREDWORLD_STRUCTURE_HYSTERESIS } from '../../shared-types/structureBudgets.js';
import { CutFieldClient, FIELD_AWAKE_FORGET_MS, MAX_CUTS_IN_FLIGHT } from './CutFieldClient.js';

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

describe('CutFieldClient background cutting (phone frames stay clear)', () => {
  /** A cutter whose cuts land only when the test says so. */
  function heldCutter() {
    const out: Array<{ cx: number; cy: number; land: () => void; fail: () => void }> = [];
    const cutter = {
      cutChunk: (field: ChunkOpts, cx: number, cy: number) => new Promise<PackedChunk>((resolve, reject) => {
        out.push({ cx, cy, land: () => resolve(packChunk(rocksInChunk(field, cx, cy), field.seed)), fail: () => reject(new Error('x')) });
      }),
    };
    return { cutter, out };
  }
  function asyncRig() {
    const { pw } = fakePredWorld();
    const pose = { x: 60_000, y: 0 };
    const drawn = new Map<string, Float32Array>();
    const held = heldCutter();
    const c = new CutFieldClient({
      gameClock: { now: () => 0 },
      predWorld: () => pw,
      localPose: () => pose,
      draw: { setFieldChunk: (cx, cy, o) => { if (o) drawn.set(`${cx},${cy}`, o); else drawn.delete(`${cx},${cy}`); } },
      cutter: () => held.cutter,
    });
    return { c, drawn, ...held };
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('never cuts on the step: asks the pool, nearest first, a few at once', () => {
    const { c, drawn, out } = asyncRig();
    live = c;
    c.setSeed('test-seed');
    c.step();
    c.step();
    expect(drawn.size).toBe(0);
    expect(out.length).toBe(MAX_CUTS_IN_FLIGHT);
    expect(`${out[0]!.cx},${out[0]!.cy}`).toBe(`${Math.floor(60_000 / CHUNK_SIZE)},0`);
  });

  it('loads a chunk the step after its cut lands, with the same rocks as an inline cut', async () => {
    const { c, drawn, out } = asyncRig();
    live = c;
    c.setSeed('test-seed');
    c.step();
    out[0]!.land();
    await flush();
    c.step();
    const key = `${out[0]!.cx},${out[0]!.cy}`;
    expect([...drawn.keys()]).toEqual([key]);
    const inline = rig();
    inline.pose.x = 60_000;
    inline.c.setSeed('test-seed');
    inline.c.step();
    expect(drawn.get(key)).toEqual(inline.drawn.get(key));
    inline.c.stop();
  });

  it('drops a cut that lands after stop, and falls back to inline if the pool fails', async () => {
    const { c, drawn, out } = asyncRig();
    live = c;
    c.setSeed('test-seed');
    c.step();
    c.stop();
    out[0]!.land();
    await flush();
    expect(drawn.size).toBe(0);
    c.setSeed('test-seed');
    c.step();
    out[out.length - 1]!.fail();
    await flush();
    c.step();
    expect(drawn.size).toBe(1);
  });
});

describe('CutFieldClient — woken rocks (macro terrain C2)', () => {
  it('an awake rock loses its fixed body, hands over its outline, and comes back once off the wire', () => {
    const { pw, bodies } = fakePredWorld();
    const pose = { x: 60_000, y: 0 };
    let now = 0;
    const c = new CutFieldClient({
      gameClock: { now: () => now },
      predWorld: () => pw,
      localPose: () => pose,
      draw: { setFieldChunk: () => {} },
    });
    live = c;
    c.setSeed('test-seed');
    for (let i = 0; i < 60; i++) c.step();
    const id = [...bodies.keys()][0]!;
    const key = Number(id.slice('field:'.length));
    const verts = c.wakeFieldRock(key);
    expect(verts, 'the cut outline').not.toBeNull();
    expect(verts!.length).toBeGreaterThanOrEqual(3);
    expect(bodies.has(id), 'fixed body dropped on wake').toBe(false);
    c.step();
    expect(bodies.has(id), 'kept out while awake').toBe(false);
    // Still on the wire: each sync re-marks it.
    now += FIELD_AWAKE_FORGET_MS - 1;
    c.wakeFieldRock(key);
    now += FIELD_AWAKE_FORGET_MS - 1;
    c.step();
    expect(bodies.has(id)).toBe(false);
    // Off the wire past the forget window: its chunk re-cut it fixed.
    now += FIELD_AWAKE_FORGET_MS + 1;
    c.step();
    expect(bodies.has(id), 'fixed body back once asleep').toBe(true);
  });

  it('an awake rock whose chunk this client has not cut gets null (generated fallback)', () => {
    const { c } = rig();
    live = c;
    c.setSeed('test-seed');
    expect(c.wakeFieldRock(12345)).toBeNull();
  });
});
