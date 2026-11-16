/**
 * Machined art bake worker: runs Machined bakes off the main thread. Frames come
 * back as transferred buffers (no copy); the main thread packs them into the
 * atlas, which needs a canvas.
 */
import { runBake, type BakeJob } from './bake.js';
import type { LightRig } from './shade.js';
import { rocksInChunk, type ChunkOpts } from '../../../core/terrain/fieldLayout.js';
import { packChunk, packedBuffers } from '../../../core/terrain/packedChunk.js';

/** A bake, or (the pool's second job) one cut-field chunk to cut. */
type Req =
  | { seq: number; job: BakeJob; rig: LightRig; cut?: undefined }
  | { seq: number; cut: { field: ChunkOpts; cx: number; cy: number } };

self.onmessage = (e: MessageEvent<Req>): void => {
  if (e.data.cut) {
    const { seq, cut } = e.data;
    const packed = packChunk(rocksInChunk(cut.field, cut.cx, cut.cy), cut.field.seed);
    (self as unknown as Worker).postMessage({ seq, packed }, packedBuffers(packed));
    return;
  }
  const { seq, job, rig } = e.data;
  const t0 = performance.now();
  const b = runBake(job, rig);
  const ms = performance.now() - t0;
  (self as unknown as Worker).postMessage({ seq, baked: b, ms }, b.frames.map((f) => f.data.buffer));
};
