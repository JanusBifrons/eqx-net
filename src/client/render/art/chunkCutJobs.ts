/**
 * The art bake pool's second job (macro terrain v2): cut one cut-field chunk
 * off the frame. Chunk cuts are a few ms each, so they go to idle workers
 * before any bake, in the order asked (nearest first). The bake worker answers
 * a `{ cut }` message with `{ packed }` (`packChunk`: outlines, ore and bodies
 * worked out there, buffers transferred), so the main thread does no per-rock
 * work. docs/architecture/macro-terrain.md.
 */
import { rocksInChunk, type ChunkOpts } from '../../../core/terrain/fieldLayout.js';
import { packChunk, type PackedChunk } from '../../../core/terrain/packedChunk.js';

export type { ChunkOpts, PackedChunk };

interface Cut { field: ChunkOpts; cx: number; cy: number; resolve: (r: PackedChunk) => void; reject: (e: Error) => void }

export class ChunkCutJobs {
  private readonly cuts: Cut[] = [];

  add(field: ChunkOpts, cx: number, cy: number): Promise<PackedChunk> {
    return new Promise((resolve, reject) => { this.cuts.push({ field, cx, cy, resolve, reject }); });
  }

  /** Hand queued cuts to idle workers; `done(w)` when a worker is free again. */
  drain(idle: Worker[], nextSeq: () => number, done: (w: Worker) => void): void {
    while (idle.length > 0 && this.cuts.length > 0) {
      const w = idle.pop()!;
      const cut = this.cuts.shift()!;
      w.onmessage = (e: MessageEvent<{ packed: PackedChunk }>): void => { cut.resolve(e.data.packed); done(w); };
      w.onerror = (err): void => { cut.reject(new Error(err.message)); done(w); };
      w.postMessage({ seq: nextSeq(), cut: { field: cut.field, cx: cut.cx, cy: cut.cy } });
    }
  }

  rejectAll(): void {
    for (const c of this.cuts) c.reject(new Error('art service destroyed'));
    this.cuts.length = 0;
  }
}

/** The no-worker fallback: one cut per macrotask on this thread. */
export function cutInline(field: ChunkOpts, cx: number, cy: number, stopped: () => boolean): Promise<PackedChunk> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (stopped()) { reject(new Error('art service destroyed')); return; }
      try { resolve(packChunk(rocksInChunk(field, cx, cy), field.seed)); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    }, 0);
  });
}
