/**
 * Machined art bake worker: runs Machined bakes off the main thread. Frames come
 * back as transferred buffers (no copy); the main thread packs them into the
 * atlas, which needs a canvas.
 */
import { runBake, type BakeJob } from './bake.js';
import type { LightRig } from './shade.js';
import { rocksInChunk, type ChunkOpts } from '../../../core/terrain/fieldLayout.js';
import { packChunk, packedBuffers } from '../../../core/terrain/packedChunk.js';
import { coarseBuffers, packCoarseField } from './chunkCutJobs.js';

/** A bake, one cut-field chunk to cut, or the far-zoom coarse field (B4). */
type Req =
  | { seq: number; job: BakeJob; rig: LightRig; cut?: undefined; coarse?: undefined }
  | { seq: number; cut: { field: ChunkOpts; cx: number; cy: number }; coarse?: undefined }
  | { seq: number; coarse: { field: ChunkOpts }; cut?: undefined };

self.onmessage = (e: MessageEvent<Req>): void => {
  if (e.data.coarse) {
    const { seq, coarse } = e.data;
    const tiles = packCoarseField(coarse.field);
    (self as unknown as Worker).postMessage({ seq, tiles }, coarseBuffers(tiles));
    return;
  }
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
