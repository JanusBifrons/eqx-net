import { describe, it, expect } from 'vitest';
import { rocksInChunk } from '../../../core/terrain/fieldLayout.js';
import { cutFieldOpts } from '../../../core/terrain/chunkStreamer.js';
import { packChunk } from '../../../core/terrain/packedChunk.js';
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
