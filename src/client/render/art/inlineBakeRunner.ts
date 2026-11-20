/**
 * The bake runner used when workers can't be created (extension point of
 * `bakeRunners.ts`, re-exported by `ArtService.ts`). Kept apart so the art service stays
 * under its god-file cap.
 */
import { runBake, type Baked, type BakeJob } from './bake.js';
import type { LightRig } from './shade.js';
import { cutCoarseInline, cutInline, type ChunkOpts, type PackedChunk, type PackedCoarseTile } from './chunkCutJobs.js';
import type { BakeRunner } from './bakeRunners.js';

/** Fallback when workers can't be created: one bake per macrotask on the
 *  current thread. Each bake still blocks for its own duration (up to a few
 *  hundred ms for the biggest structures), so this is a last resort. */
export class InlineBakeRunner implements BakeRunner {
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  constructor(private readonly delayMs = 0) {}
  get workers(): number { return 0; }
  run(job: BakeJob, rig: LightRig, _urgent = true): Promise<Baked> {
    const p = this.chain.then(() => new Promise<Baked>((resolve, reject) => {
      setTimeout(() => {
        if (this.stopped) { reject(new Error('art service destroyed')); return; }
        try { resolve(runBake(job, rig)); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
      }, 0);
    }));
    this.chain = p.catch(() => undefined);
    // As in the worker pool, the test delay holds back the result, not the queue.
    return this.delayMs > 0 ? p.then((b) => new Promise<Baked>((resolve) => { setTimeout(() => resolve(b), this.delayMs); })) : p;
  }
  cutChunk(field: ChunkOpts, cx: number, cy: number): Promise<PackedChunk> { return cutInline(field, cx, cy, () => this.stopped); }
  cutCoarseField(field: ChunkOpts): Promise<PackedCoarseTile[]> { return cutCoarseInline(field, () => this.stopped); }
  destroy(): void { this.stopped = true; }
}
