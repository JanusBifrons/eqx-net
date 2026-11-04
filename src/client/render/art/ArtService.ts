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
import type { Texture } from 'pixi.js';
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

export interface ArtHandle {
  readonly key: string;
  readonly job: BakeJob;
  /** The sun it is baked under (the sector's when it was requested). */
  readonly rig: LightRig;
  state: ArtState;
  ship: ShipArt | null;
  struct: StructArt | null;
  /** Why it failed (bake error, too big, over the memory budget). */
  reason?: string;
}

/** Packs frames into GPU pages. `Atlas` in the game; a fake in tests. */
export interface ArtPacker {
  canFit(frames: readonly Frame[]): boolean;
  add(fr: Frame, out: Texture[], idx: number): boolean;
  commit(): void;
  readonly pageCount: number;
  readonly gpuBytes: number;
  destroy(): void;
}

/** Runs bakes somewhere other than the caller's stack. */
export interface BakeRunner {
  run(job: BakeJob, rig: LightRig): Promise<Baked>;
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
}

/** Defaults by device: phones get small pages and a tight page budget. */
export function atlasOptsFor(touch: boolean): AtlasOpts {
  return touch ? { pageSize: 2048, maxPages: 6 } : { pageSize: 4096, maxPages: 4 };
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

  ship(id: string, paint?: number): ArtHandle {
    return this.acquire({ type: 'ship', id, paint });
  }

  struct(id: string, seed: number, rot = 0, accent?: number): ArtHandle {
    return this.acquire({ type: 'struct', id, seed: seedVariant(seed), rot, accent });
  }

  /** One component of a destroyed ship (tumbles: ship-style frames). */
  scrap(parentKind: string, component: number): ArtHandle {
    return this.acquire({ type: 'scrap', id: parentKind, component });
  }

  /** An asteroid by its seeded outline (static: one frame at its turn). */
  rock(entityId: number, radius: number, resource: string | undefined, rot: number): ArtHandle {
    return this.acquire({ type: 'rock', id: 'asteroid', entityId, radius, resource, rot });
  }

  /** The handle for a job: an existing one if any, else a new pending one
   *  whose bake starts now. */
  acquire(job: BakeJob): ArtHandle {
    const key = `${bakeKey(job)}|${this.rigTag}`;
    let h = this.handles.get(key);
    if (h) return h;
    h = { key, job, rig: this.rig, state: 'pending', ship: null, struct: null };
    this.handles.set(key, h);
    void this.start(h);
    return h;
  }

  private async start(h: ArtHandle): Promise<void> {
    const sk = storeKey(bakeKey(h.job), h.rig);
    try {
      const hit = this.deps.cache ? (await this.deps.cache.load([sk])).get(sk) : undefined;
      if (this.destroyed) return;
      if (hit) { this.toPack.push({ h, b: hit, cached: true }); return; }
      const b = await this.deps.runner.run(h.job, h.rig);
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

  private readonly pendingFill: Array<() => void> = [];

  /** Resolve the textures of everything packed this tick (after commit). */
  private flushFills(): void {
    for (const f of this.pendingFill) f();
    this.pendingFill.length = 0;
  }

  stats(): ArtStats {
    let ready = 0, pending = 0, failed = 0;
    for (const h of this.handles.values()) {
      if (h.state === 'ready') ready++;
      else if (h.state === 'pending') pending++;
      else failed++;
    }
    return {
      ready, pending, failed, fromCache: this.fromCache,
      pages: this.deps.packer.pageCount, gpuBytes: this.deps.packer.gpuBytes, workers: this.deps.runner.workers,
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

  run(job: BakeJob, rig: LightRig): Promise<Baked> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, rig, resolve, reject });
      this.pump();
    });
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
  run(job: BakeJob, rig: LightRig): Promise<Baked> {
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
