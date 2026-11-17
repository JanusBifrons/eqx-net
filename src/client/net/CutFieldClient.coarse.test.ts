/**
 * Far zoom (macro terrain B4, slice 2): the client asks the bake pool for the
 * whole field's coarse tiles once per sector, after the first full-detail
 * chunk lands, and draws them through the same sink as chunks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { PhysicsWorld } from '@core/physics/World';
import type { ChunkOpts } from '@core/terrain/fieldLayout';
import type { PackedCoarseTile } from '@core/terrain/packedChunk';
import { CutFieldClient, type ChunkCutter } from './CutFieldClient.js';

function rig() {
  const asks: Array<{ seed: string; resolve: (t: PackedCoarseTile[]) => void; reject: (e: Error) => void }> = [];
  const cutter: ChunkCutter = {
    cutCoarseField: (field: ChunkOpts) => new Promise<PackedCoarseTile[]>((resolve, reject) => { asks.push({ seed: field.seed, resolve, reject }); }),
  };
  const tiles = new Map<string, Float32Array>();
  const pw = { spawnObstacle() {}, fixBody() {}, despawnShip() {} } as unknown as PhysicsWorld;
  const c = new CutFieldClient({
    gameClock: { now: () => 0 },
    predWorld: () => pw,
    localPose: () => ({ x: 60_000, y: 0 }), // in the field ring
    draw: {
      setFieldChunk: () => {},
      setCoarseTile: (tx, ty, outlines) => { if (outlines) tiles.set(`${tx},${ty}`, outlines); else tiles.delete(`${tx},${ty}`); },
    },
    cutter: () => cutter,
  });
  return { c, asks, tiles };
}

const tile = (tx: number, ty: number): PackedCoarseTile => ({ tx, ty, outlines: new Float32Array([3, 0, 0, 1, 0, 0, 1]), ore: new Float32Array(8) });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let live: CutFieldClient | null = null;
afterEach(() => { live?.stop(); live = null; });

describe('CutFieldClient — far-zoom coarse field (B4)', () => {
  it('asks for the coarse field once, after the first chunk lands, and draws its tiles', async () => {
    const { c, asks, tiles } = rig();
    live = c;
    c.setSeed('test-seed');
    expect(asks.length, 'nothing before a chunk has landed').toBe(0);
    for (let i = 0; i < 10; i++) c.step();
    expect(asks.map((a) => a.seed)).toEqual(['test-seed']);
    asks[0]!.resolve([tile(1, 0), tile(2, 0)]);
    await flush();
    expect([...tiles.keys()]).toEqual(['1,0', '2,0']);
    for (let i = 0; i < 10; i++) c.step();
    expect(asks.length, 'exactly one job per sector').toBe(1);
  });

  it('a sector change drops the tiles and asks again for the new seed', async () => {
    const { c, asks, tiles } = rig();
    live = c;
    c.setSeed('seed-a');
    c.step();
    asks[0]!.resolve([tile(1, 0)]);
    await flush();
    expect(tiles.size).toBe(1);
    c.setSeed('seed-b');
    expect(tiles.size, 'the old sector\'s tiles are dropped').toBe(0);
    c.step();
    expect(asks.map((a) => a.seed)).toEqual(['seed-a', 'seed-b']);
  });

  it('ignores a result that lands after stop (stale)', async () => {
    const { c, asks, tiles } = rig();
    live = c;
    c.setSeed('test-seed');
    c.step();
    c.stop();
    asks[0]!.resolve([tile(1, 0)]);
    await flush();
    expect(tiles.size).toBe(0);
    // And after a sector change: the old seed's answer never draws.
    c.setSeed('seed-b');
    c.step();
    c.setSeed('seed-c');
    asks[1]!.resolve([tile(5, 5)]);
    await flush();
    expect(tiles.size).toBe(0);
  });
});
