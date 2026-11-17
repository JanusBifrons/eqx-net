import { describe, it, expect } from 'vitest';
import { coarseFieldTiles, rocksInChunk } from '../../../core/terrain/fieldLayout.js';
import { cutFieldOpts } from '../../../core/terrain/chunkStreamer.js';
import { packChunk, packCoarseTile, type PackedCoarseTile } from '../../../core/terrain/packedChunk.js';
import { InlineBakeRunner, WorkerBakeRunner } from './ArtService.js';

const field = cutFieldOpts('test-seed');
const CX = 15, CY = 0; // in the field ring

/** A worker that answers cut messages the way bake.worker.ts does. */
function fakeWorker(log: string[]): Worker {
  const w = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null,
    postMessage(msg: { seq: number; cut?: { cx: number; cy: number } }) {
      log.push(msg.cut ? `cut ${msg.cut.cx},${msg.cut.cy}` : 'bake');
      if (msg.cut) {
        const packed = packChunk(rocksInChunk(field, msg.cut.cx, msg.cut.cy), field.seed);
        queueMicrotask(() => w.onmessage?.({ data: { seq: msg.seq, packed } }));
      }
    },
    terminate() {},
  };
  return w as unknown as Worker;
}

describe('the art bake pool cuts cut-field chunks (macro terrain v2)', () => {
  it('a worker cut returns the same rocks as an inline cut (#15)', async () => {
    const log: string[] = [];
    const r = new WorkerBakeRunner(1, () => fakeWorker(log));
    const packed = await r.cutChunk(field, CX, CY);
    expect(packed).toEqual(packChunk(rocksInChunk(field, CX, CY), field.seed));
    expect(log).toEqual([`cut ${CX},${CY}`]);
    r.destroy();
  });

  it('runs queued cuts in the order asked', async () => {
    const log: string[] = [];
    const r = new WorkerBakeRunner(1, () => fakeWorker(log));
    await Promise.all([r.cutChunk(field, 1, 2), r.cutChunk(field, 3, 4)]);
    expect(log).toEqual(['cut 1,2', 'cut 3,4']);
    r.destroy();
  });

  it('the inline runner cuts too (no Worker on the page)', async () => {
    const r = new InlineBakeRunner();
    expect(await r.cutChunk(field, CX, CY)).toEqual(packChunk(rocksInChunk(field, CX, CY), field.seed));
    r.destroy();
  });
});

describe('the art bake pool cuts the far-zoom coarse field (B4)', () => {
  const small = cutFieldOpts('coarse-seed');
  const direct = (): PackedCoarseTile[] => coarseFieldTiles(small).map((t) => packCoarseTile(t, small.seed));

  it('the inline runner returns the same tiles as packCoarseTile directly (#15)', async () => {
    const r = new InlineBakeRunner();
    const tiles = await r.cutCoarseField(small);
    expect(tiles.length).toBeGreaterThan(10);
    expect(tiles).toEqual(direct());
    r.destroy();
  });

  it('a worker answers a coarse message with the tiles, queued behind earlier chunk cuts', async () => {
    const log: string[] = [];
    const want = direct();
    const w = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      onerror: null,
      postMessage(msg: { seq: number; cut?: { cx: number; cy: number }; coarse?: { field: unknown } }) {
        log.push(msg.coarse ? 'coarse' : msg.cut ? `cut ${msg.cut.cx},${msg.cut.cy}` : 'bake');
        const data = msg.coarse ? { seq: msg.seq, tiles: want } : { seq: msg.seq, packed: packChunk(rocksInChunk(field, msg.cut!.cx, msg.cut!.cy), field.seed) };
        queueMicrotask(() => w.onmessage?.({ data }));
      },
      terminate() {},
    };
    const r = new WorkerBakeRunner(1, () => w as unknown as Worker);
    const [, tiles] = await Promise.all([r.cutChunk(field, 1, 2), r.cutCoarseField(small)]);
    expect(tiles).toBe(want);
    expect(log).toEqual(['cut 1,2', 'coarse']);
    r.destroy();
  });
});
