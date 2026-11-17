/**
 * The art bake pool's second job (macro terrain v2): cut one cut-field chunk
 * off the frame. Chunk cuts are a few ms each, so they go to idle workers
 * before any bake, in the order asked (nearest first). The bake worker answers
 * a `{ cut }` message with `{ packed }` (`packChunk`: outlines, ore and bodies
 * worked out there, buffers transferred), so the main thread does no per-rock
 * work. The same queue carries the far-zoom coarse field (B4, once per
 * sector): a `{ coarse }` message answered with `{ tiles }`
 * (`packCoarseField`). docs/architecture/macro-terrain.md.
 */
import { coarseFieldTiles, rocksInChunk, type ChunkOpts } from '../../../core/terrain/fieldLayout.js';
import { packChunk, packCoarseTile, type PackedChunk, type PackedCoarseTile } from '../../../core/terrain/packedChunk.js';

export type { ChunkOpts, PackedChunk, PackedCoarseTile };

/** The whole field's far-zoom tiles, packed for drawing (worker side). */
export function packCoarseField(field: ChunkOpts): PackedCoarseTile[] {
  return coarseFieldTiles(field).map((t) => packCoarseTile(t, field.seed));
}

/** The tiles' buffers, to transfer from the worker (no copy). */
export const coarseBuffers = (tiles: readonly PackedCoarseTile[]): ArrayBuffer[] =>
  tiles.flatMap((t) => [t.outlines.buffer as ArrayBuffer, t.ore.buffer as ArrayBuffer]);

type CutMsg = { field: ChunkOpts; cx: number; cy: number } | { field: ChunkOpts; coarse: true };
interface Cut { msg: CutMsg; resolve: (r: never) => void; reject: (e: Error) => void }

export class ChunkCutJobs {
  private readonly cuts: Cut[] = [];

  add(field: ChunkOpts, cx: number, cy: number): Promise<PackedChunk> {
    return new Promise((resolve, reject) => { this.cuts.push({ msg: { field, cx, cy }, resolve, reject }); });
  }

  /** The far-zoom coarse field, queued behind the chunk cuts asked before it. */
  addCoarse(field: ChunkOpts): Promise<PackedCoarseTile[]> {
    return new Promise((resolve, reject) => { this.cuts.push({ msg: { field, coarse: true }, resolve, reject }); });
  }

  /** Hand queued cuts to idle workers; `done(w)` when a worker is free again. */
  drain(idle: Worker[], nextSeq: () => number, done: (w: Worker) => void): void {
    while (idle.length > 0 && this.cuts.length > 0) {
      const w = idle.pop()!;
      const cut = this.cuts.shift()!;
      const m = cut.msg;
      w.onmessage = (e: MessageEvent<{ packed?: PackedChunk; tiles?: PackedCoarseTile[] }>): void => {
        (cut.resolve as (r: unknown) => void)('coarse' in m ? e.data.tiles : e.data.packed);
        done(w);
      };
      w.onerror = (err): void => { cut.reject(new Error(err.message)); done(w); };
      if ('coarse' in m) w.postMessage({ seq: nextSeq(), coarse: { field: m.field } });
      else w.postMessage({ seq: nextSeq(), cut: { field: m.field, cx: m.cx, cy: m.cy } });
    }
  }

  rejectAll(): void {
    for (const c of this.cuts) c.reject(new Error('art service destroyed'));
    this.cuts.length = 0;
  }
}

/** The no-worker fallback: one job per macrotask on this thread. */
function inline<T>(work: () => T, stopped: () => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (stopped()) { reject(new Error('art service destroyed')); return; }
      try { resolve(work()); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    }, 0);
  });
}

/** The no-worker fallback: one cut per macrotask on this thread. */
export function cutInline(field: ChunkOpts, cx: number, cy: number, stopped: () => boolean): Promise<PackedChunk> {
  return inline(() => packChunk(rocksInChunk(field, cx, cy), field.seed), stopped);
}

/** The no-worker fallback for the coarse field (one long macrotask). */
export function cutCoarseInline(field: ChunkOpts, stopped: () => boolean): Promise<PackedCoarseTile[]> {
  return inline(() => packCoarseField(field), stopped);
}
