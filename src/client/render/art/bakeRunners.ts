/**
 * Bake runners for `ArtService` (re-exported there): a small pool of module
 * workers, and the inline fallback when workers can't be created
 * (`inlineBakeRunner.ts`). Both also cut cut-field chunks and far-zoom tiles off the frame (`chunkCutJobs.ts`).
 */
import { bakeKey, type Baked, type BakeJob } from './bake.js';
import type { LightRig } from './shade.js';
import { ChunkCutJobs, type ChunkOpts, type PackedChunk, type PackedCoarseTile } from './chunkCutJobs.js';

/** Runs bakes somewhere other than the caller's stack. */
export interface BakeRunner {
  /** `urgent`: something on screen is waiting for it, so it goes ahead of
   *  queued warm-up work. */
  run(job: BakeJob, rig: LightRig, urgent?: boolean): Promise<Baked>;
  /** Move a queued (not yet started) job to the front. */
  promote?(job: BakeJob): void;
  cutChunk?(field: ChunkOpts, cx: number, cy: number): Promise<PackedChunk>; // cut-field chunks, off the frame (chunkCutJobs.ts)
  cutCoarseField?(field: ChunkOpts): Promise<PackedCoarseTile[]>; // the far-zoom tiles (B4), once per sector
  readonly workers: number;
  destroy(): void;
}

/** Runs bakes on a small pool of module workers. */
export class WorkerBakeRunner implements BakeRunner {
  private readonly pool: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ job: BakeJob; rig: LightRig; resolve: (b: Baked) => void; reject: (e: Error) => void }> = [];
  private readonly cuts = new ChunkCutJobs();
  private seq = 0;

  constructor(size: number, factory: () => Worker, private readonly delayMs = 0) {
    for (let i = 0; i < size; i++) {
      const w = factory();
      this.pool.push(w);
      this.idle.push(w);
    }
  }
  get workers(): number { return this.pool.length; }
  run(job: BakeJob, rig: LightRig, urgent = true): Promise<Baked> {
    return new Promise((resolve, reject) => {
      const item = { job, rig, resolve, reject };
      if (urgent) this.queue.unshift(item); else this.queue.push(item);
      this.pump();
    });
  }

  promote(job: BakeJob): void {
    const k = bakeKey(job);
    const i = this.queue.findIndex((q) => bakeKey(q.job) === k);
    if (i > 0) this.queue.unshift(this.queue.splice(i, 1)[0]!);
  }

  cutChunk(field: ChunkOpts, cx: number, cy: number): Promise<PackedChunk> { const p = this.cuts.add(field, cx, cy); this.pump(); return p; }
  cutCoarseField(field: ChunkOpts): Promise<PackedCoarseTile[]> { const p = this.cuts.addCoarse(field); this.pump(); return p; }
  private pump(): void {
    this.cuts.drain(this.idle, () => this.seq++, (w) => { this.idle.push(w); this.pump(); });
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const item = this.queue.shift()!;
      const seq = this.seq++;
      const done = (): void => { this.idle.push(w); this.pump(); };
      w.onmessage = (e: MessageEvent<{ seq: number; baked: Baked }>): void => {
        // The test delay holds back the RESULT, not the worker: each bake still
        // lands delayMs after it is done, but the queue drains at full speed
        // (holding the worker made N bakes take N x delay / pool size).
        if (this.delayMs > 0) { const baked = e.data.baked; done(); setTimeout(() => item.resolve(baked), this.delayMs); return; }
        item.resolve(e.data.baked); done();
      };
      w.onerror = (err): void => { item.reject(new Error(err.message)); done(); };
      w.postMessage({ seq, job: item.job, rig: item.rig });
    }
  }

  destroy(): void {
    for (const w of this.pool) w.terminate();
    this.pool.length = 0;
    this.idle.length = 0;
    for (const q of this.queue) q.reject(new Error('art service destroyed'));
    this.queue.length = 0;
    this.cuts.rejectAll();
  }
}

export { InlineBakeRunner } from './inlineBakeRunner.js';
