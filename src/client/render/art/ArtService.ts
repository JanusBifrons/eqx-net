/**
 * Machined art — the renderer's art service (plan iridescent-seeking-rainbow, A2).
 *
 * The renderer asks for art by kind and gets a HANDLE back at once. The
 * handle starts `pending`; the bake runs off the main path (worker pool, or
 * inline as a fallback), lands in the cross-session cache, and is packed into
 * the atlas within a per-frame time budget, at which point the handle turns
 * `ready`. A sprite keeps drawing today's look until then, so nothing ever
 * waits on a bake.
 *
 * Handles are created once per distinct (kind, paint, seed, turn, sun) and
 * reused, so a sprite holds its handle and checks it each frame without
 * allocating (invariant #14).
 */
import { Rectangle, Texture } from 'pixi.js';
import { FX_SPECS, isFxId, type FxId, type FxSpec } from './fx/fxTextures.js';
import { Atlas, type AtlasOpts } from './atlas.js';
import { bakeKey, runBake, seedVariant, type Baked, type BakeJob } from './bake.js';
import { loadBakes, saveBakes, storeKey } from './bakeStore.js';
import type { Frame, LightRig } from './shade.js';
import { sunRigForSector } from './sunRig.js';

export type ArtState = 'pending' | 'ready' | 'failed';

export interface ShipArt {
  /** One frame per baked sun angle (SUN_STEPS), cross-faded at run time. */
  frames: Texture[];
  w: number;
  h: number;
  /** Texels per world unit: a sprite's scale is 1 / density. */
  density: number;
  nozzles: Baked['nozzles'];
  navLights: Baked['navLights'];
}

export interface StructArt {
  tex: Texture;
  /** Unlit copy at half resolution: what blast light lifts. */
  albedo: Texture;
  w: number;
  h: number;
  density: number;
  navLights: Baked['navLights'];
}

/** An effect or backdrop texture; `frames` holds a flipbook's cells (else [tex]). */
export interface FxArt {
  tex: Texture;
  frames: Texture[];
  w: number;
  h: number;
}

export interface ArtHandle {
  readonly key: string;
  readonly job: BakeJob;
  /** The sun it is baked under (the sector's when it was requested). */
  readonly rig: LightRig;
  state: ArtState;
  ship: ShipArt | null;
  struct: StructArt | null;
  fx?: FxArt | null;
  /** Why it failed (bake error, too big, over the memory budget). */
  reason?: string;
}

/** Packs frames into GPU pages. `Atlas` in the game; a fake in tests. */
export interface ArtPacker {
  canFit(frames: readonly Frame[]): boolean;
  add(fr: Frame, out: Texture[], idx: number): boolean;
  commit(): void;
  /** A texture outside the pages (wrapping textures). */
  standalone(fr: Frame, repeat: boolean, mip: boolean): Texture;
  readonly pageCount: number;
  readonly gpuBytes: number;
  destroy(): void;
}

/** Runs bakes somewhere other than the caller's stack. */
export interface BakeRunner {
  /** `urgent`: something on screen is waiting for it, so it goes ahead of
   *  queued warm-up work. */
  run(job: BakeJob, rig: LightRig, urgent?: boolean): Promise<Baked>;
  /** Move a queued (not yet started) job to the front. */
  promote?(job: BakeJob): void;
  readonly workers: number;
  destroy(): void;
}

export interface BakeCache {
  load(keys: string[]): Promise<Map<string, Baked>>;
  save(entries: Array<[string, Baked]>): Promise<void>;
}

export interface ArtServiceDeps {
  packer: ArtPacker;
  runner: BakeRunner;
  cache: BakeCache | null;
  now: () => number;
  /** Most ms per `tick()` spent packing (at least one bake is packed). */
  packBudgetMs: number;
}

export interface ArtStats {
  ready: number;
  pending: number;
  failed: number;
  fromCache: number;
  pages: number;
  gpuBytes: number;
  workers: number;
  /** Effect textures ready / still baking. */
  fxReady: number;
  fxPending: number;
}

/** Defaults by device: phones get small pages and a tight page budget. */
export function atlasOptsFor(touch: boolean): AtlasOpts {
  return touch ? { pageSize: 2048, maxPages: 6 } : { pageSize: 4096, maxPages: 4 };
}

/** Cut a flipbook sheet texture into its cells (same source, so they batch). */
export function flipCells(sheet: Texture, flip: NonNullable<FxSpec['flip']>): Texture[] {
  const out: Texture[] = [];
  const f = sheet.frame;
  for (let i = 0; i < flip.frames; i++) {
    out.push(new Texture({ source: sheet.source, frame: new Rectangle(f.x + (i % flip.cols) * flip.cell, f.y + Math.floor(i / flip.cols) * flip.cell, flip.cell, flip.cell) }));
  }
  return out;
}

export class ArtService {
  private readonly handles = new Map<string, ArtHandle>();
  /** Finished bakes waiting to be packed, oldest first. */
  private readonly toPack: Array<{ h: ArtHandle; b: Baked; cached: boolean }> = [];
  private readonly toSave: Array<[string, Baked]> = [];
  private rig: LightRig = sunRigForSector(null);
  private rigTag = rigTag(this.rig);
  private fromCache = 0;
  private destroyed = false;

  constructor(private readonly deps: ArtServiceDeps) {}

  /** The sector changed: new requests are lit by its sun. Art already baked
   *  for other suns stays usable until it's released. */
  setSector(sectorKey: string | null): void {
    this.rig = sunRigForSector(sectorKey);
    this.rigTag = rigTag(this.rig);
  }

  get lightRig(): LightRig { return this.rig; }

  ship(id: string, paint?: number, urgent = true): ArtHandle {
    return this.acquire({ type: 'ship', id, paint }, urgent);
  }

  struct(id: string, seed: number, rot = 0, accent?: number, urgent = true): ArtHandle {
    return this.acquire({ type: 'struct', id, seed: seedVariant(seed), rot, accent }, urgent);
  }

  /** Queue background bakes for art the player is likely to see soon (see
   *  warmUp.ts), behind anything on screen. Called when the renderer starts,
   *  i.e. on the galaxy map / warp screen, so the swap from today's look is
   *  rarely visible in play. */
  warmUp(jobs: readonly BakeJob[]): void {
    for (const j of jobs) this.acquire(j, false);
  }

  /** One component of a destroyed ship (tumbles: ship-style frames). */
  /** An effect or backdrop texture (art/fx/fxTextures.ts). */
  fx(id: FxId, variant?: string, seed?: number, urgent = true): ArtHandle {
    return this.acquire({ type: 'fx', id, ...(variant !== undefined ? { variant } : {}), ...(seed !== undefined ? { seed } : {}) }, urgent);
  }

  scrap(parentKind: string, component: number): ArtHandle {
    return this.acquire({ type: 'scrap', id: parentKind, component });
  }

  /** An asteroid by its seeded outline (static: one frame at its turn). */
  rock(entityId: number, radius: number, resource: string | undefined, rot: number): ArtHandle {
    return this.acquire({ type: 'rock', id: 'asteroid', entityId, radius, resource, rot });
  }

  /** The handle for a job: an existing one if any, else a new pending one
   *  whose bake starts now. */
  acquire(job: BakeJob, urgent = true): ArtHandle {
    const key = `${bakeKey(job)}|${this.rigTag}`;
    let h = this.handles.get(key);
    if (h) {
      // A warm-up bake still queued: something now needs it, so move it up.
      if (urgent && h.state === 'pending' && !this.urgentKeys.has(key)) {
        this.urgentKeys.add(key);
        this.deps.runner.promote?.(h.job);
      }
      return h;
    }
    h = { key, job, rig: this.rig, state: 'pending', ship: null, struct: null };
    this.handles.set(key, h);
    if (urgent) this.urgentKeys.add(key);
    void this.start(h, urgent);
    return h;
  }

  /** Handles something on screen asked for (vs warm-up only). */
  private readonly urgentKeys = new Set<string>();

  private async start(h: ArtHandle, urgent: boolean): Promise<void> {
    const sk = storeKey(bakeKey(h.job), h.rig);
    try {
      const hit = this.deps.cache ? (await this.deps.cache.load([sk])).get(sk) : undefined;
      if (this.destroyed) return;
      if (hit) { this.toPack.push({ h, b: hit, cached: true }); return; }
      const b = await this.deps.runner.run(h.job, h.rig, urgent || this.urgentKeys.has(h.key));
      if (this.destroyed) return;
      this.toPack.push({ h, b, cached: false });
    } catch (e) {
      h.state = 'failed';
      h.reason = `bake failed: ${String(e)}`;
    }
  }

  /** Pack finished bakes into the atlas, within the per-frame budget. Call
   *  once per rendered frame. */
  tick(): void {
    if (this.toPack.length === 0) return;
    const t0 = this.deps.now();
    let packed = 0;
    while (this.toPack.length > 0) {
      if (packed > 0 && this.deps.now() - t0 >= this.deps.packBudgetMs) break;
      const { h, b, cached } = this.toPack.shift()!;
      if (!this.pack(h, b)) continue;
      packed++;
      if (cached) this.fromCache++;
      else this.toSave.push([storeKey(bakeKey(h.job), h.rig), b]);
    }
    // Upload, then hand out the textures: a handle turns `ready` only here.
    if (packed > 0) { this.deps.packer.commit(); this.flushFills(); }
    if (this.toSave.length > 0 && this.deps.cache) {
      const batch = this.toSave.splice(0, this.toSave.length);
      void this.deps.cache.save(batch);
    }
  }

  /** Place a bake's frames; false (handle failed) if it won't fit the budget. */
  private pack(h: ArtHandle, b: Baked): boolean {
    const packer = this.deps.packer;
    if (h.job.type === 'fx') return this.packFx(h, h.job.id, b);
    if (!packer.canFit(b.frames)) {
      h.state = 'failed';
      h.reason = 'over the texture memory budget';
      return false;
    }
    const tex: Texture[] = [];
    for (let i = 0; i < b.frames.length; i++) packer.add(b.frames[i]!, tex, i);
    // Textures resolve on commit (end of this tick); fill the handle then.
    this.pendingFill.push(() => {
      if (h.job.type === 'ship' || h.job.type === 'scrap') {
        h.ship = { frames: tex, w: b.w, h: b.h, density: b.density, nozzles: b.nozzles, navLights: b.navLights };
      } else {
        h.struct = { tex: tex[0]!, albedo: tex[1]!, w: b.w, h: b.h, density: b.density, navLights: b.navLights };
      }
      h.state = 'ready';
    });
    return true;
  }

  /** Effects: wrapping textures get their own; the rest share the atlas,
   *  and a flipbook sheet is cut into its cells. */
  private packFx(h: ArtHandle, id: string, b: Baked): boolean {
    const spec = isFxId(id) ? FX_SPECS[id] : null;
    const fr = b.frames[0];
    if (!spec || !fr) { h.state = 'failed'; h.reason = 'unknown effect texture'; return false; }
    if (spec.tile) {
      const tex = this.deps.packer.standalone(fr, true, spec.mip === true);
      this.pendingFill.push(() => { h.fx = { tex, frames: [tex], w: fr.w, h: fr.h }; h.state = 'ready'; });
      return true;
    }
    if (!this.deps.packer.canFit(b.frames)) { h.state = 'failed'; h.reason = 'over the texture memory budget'; return false; }
    const out: Texture[] = [];
    this.deps.packer.add(fr, out, 0);
    this.pendingFill.push(() => {
      const tex = out[0]!;
      h.fx = { tex, frames: spec.flip ? flipCells(tex, spec.flip) : [tex], w: fr.w, h: fr.h };
      h.state = 'ready';
    });
    return true;
  }

  private readonly pendingFill: Array<() => void> = [];

  /** Resolve the textures of everything packed this tick (after commit). */
  private flushFills(): void {
    for (const f of this.pendingFill) f();
    this.pendingFill.length = 0;
  }

  stats(): ArtStats {
    let ready = 0, pending = 0, failed = 0, fxReady = 0, fxPending = 0;
    for (const h of this.handles.values()) {
      const isFx = h.job.type === 'fx';
      if (h.state === 'ready') { ready++; if (isFx) fxReady++; }
      else if (h.state === 'pending') { pending++; if (isFx) fxPending++; }
      else failed++;
    }
    return {
      ready, pending, failed, fromCache: this.fromCache,
      pages: this.deps.packer.pageCount, gpuBytes: this.deps.packer.gpuBytes, workers: this.deps.runner.workers, fxReady, fxPending,
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.deps.runner.destroy();
    this.deps.packer.destroy();
    this.handles.clear();
    this.toPack.length = 0;
  }

}

function rigTag(r: LightRig): string {
  return `${r.sunAz.toFixed(4)},${r.sunElev.toFixed(4)},${r.exposure}`;
}

// ---------------------------------------------------------------- runners

/** Runs bakes on a small pool of module workers. */
export class WorkerBakeRunner implements BakeRunner {
  private readonly pool: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ job: BakeJob; rig: LightRig; resolve: (b: Baked) => void; reject: (e: Error) => void }> = [];
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

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const item = this.queue.shift()!;
      const seq = this.seq++;
      const done = (): void => { this.idle.push(w); this.pump(); };
      w.onmessage = (e: MessageEvent<{ seq: number; baked: Baked }>): void => {
        const finish = (): void => { item.resolve(e.data.baked); done(); };
        if (this.delayMs > 0) setTimeout(finish, this.delayMs); else finish();
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
  }
}

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
      }, this.delayMs);
    }));
    this.chain = p.catch(() => undefined);
    return p;
  }
  destroy(): void { this.stopped = true; }
}

// ---------------------------------------------------------------- factory

export interface CreateArtServiceOpts {
  touch: boolean;
  /** Test-only bake delay (`?artDelayMs=`). */
  delayMs?: number;
  maxWorkers?: number;
}

/** The real thing: atlas sized for the device, a worker pool (inline if
 *  workers are unavailable), and the IndexedDB cache. */
export function createArtService(o: CreateArtServiceOpts): ArtService {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  const n = Math.max(1, Math.min(o.maxWorkers ?? 4, cores - 1));
  let runner: BakeRunner;
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker');
    runner = new WorkerBakeRunner(n, () => new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' }), o.delayMs ?? 0);
  } catch {
    runner = new InlineBakeRunner(o.delayMs ?? 0);
  }
  return new ArtService({
    packer: new Atlas(false, atlasOptsFor(o.touch)),
    runner,
    cache: { load: loadBakes, save: saveBakes },
    now: () => performance.now(),
    packBudgetMs: 3,
  });
}
