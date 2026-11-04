/**
 * Art lab — baked art per style, cached by kind (+ zoom level and settings for
 * the pixel look). Bake time and atlas bytes are tallied for the bench.
 *
 * Machined bakes can run ahead on worker threads (`prebake`): the forge is
 * pure, so workers return plain RGBA frames and only the atlas packing (it
 * needs a canvas) stays on the main thread. Anything not prebaked is baked on
 * the main thread on first use, with the same code.
 */
import type { Texture } from 'pixi.js';
import { Atlas } from '../render/art/atlas.js';
import { forgeShip, forgeStructure, type Fields } from '../render/art/fields.js';
import { DEFAULT_RIG, type LightRig } from '../render/art/shade.js';
import { pixelFrame } from './pixel.js';
import {
  bakeKey, runBake, seedVariant, shipPpu, STRUCT_MAX_SIDE, STRUCT_PPU, SUN_STEPS,
  type Baked, type BakeJob,
} from '../render/art/bake.js';
import { loadBakes, saveBakes, storeKey } from '../render/art/bakeStore.js';

export { SUN_STEPS };

/** Pixel ships keep this many baked rotations. */
export const PIXEL_ROT_STEPS = 64;

export interface ShipArt {
  frames: Texture[];
  /** Frame size in texels and texels per world unit. */
  w: number;
  h: number;
  density: number;
  nozzles: Fields['nozzles'];
  navLights: Fields['navLights'];
}

export interface StructArt {
  tex: Texture;
  /** Unlit albedo (machined only): what point lights multiply. */
  albedo?: Texture;
  w: number;
  h: number;
  density: number;
  navLights: Fields['navLights'];
}

export interface PixelSettings {
  steps: number;
  dither: number;
  outline: boolean;
}

export class ArtCache {
  readonly smooth = new Atlas(false);
  readonly pixel = new Atlas(true);
  readonly bakeMs = { ships: 0, structures: 0, pixelShips: 0, pixelStructures: 0 };
  private ships = new Map<string, ShipArt>();
  private structs = new Map<string, StructArt>();
  private fieldCache = new Map<string, Fields>();
  /** Finished bakes from `prebake`, waiting to be packed on first use. */
  private prebaked = new Map<string, Baked>();
  /** Wall-clock of the last `prebake`, and how many workers it used. */
  prebakeMs = 0;
  prebakeWorkers = 0;
  /** How many of the last prebake's jobs came from the between-session store. */
  prebakeFromStore = 0;
  rig: LightRig = DEFAULT_RIG;

  /**
   * Bake the given Machined jobs on up to `maxWorkers` worker threads in
   * parallel. Resolves when all are done; falls back to the main thread when
   * workers are unavailable.
   */
  async prebake(jobs: BakeJob[], maxWorkers = 4, persist = true): Promise<void> {
    const t0 = performance.now();
    const seen = new Set<string>();
    let todo: BakeJob[] = [];
    for (const j of jobs) {
      const k = bakeKey(j);
      if (seen.has(k) || this.prebaked.has(k)) continue;
      seen.add(k);
      todo.push(j);
    }
    // Reuse art baked in an earlier session.
    if (persist) {
      const hits = await loadBakes(todo.map((j) => storeKey(bakeKey(j), this.rig)));
      this.prebakeFromStore = 0;
      todo = todo.filter((j) => {
        const b = hits.get(storeKey(bakeKey(j), this.rig));
        if (!b) return true;
        this.prebaked.set(bakeKey(j), b);
        this.prebakeFromStore++;
        return false;
      });
    }
    const fresh = todo.map(bakeKey);
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const n = Math.max(1, Math.min(maxWorkers, cores - 1, todo.length));
    const workers: Worker[] = [];
    try {
      for (let i = 0; i < n; i++) workers.push(new Worker(new URL('../render/art/bake.worker.ts', import.meta.url), { type: 'module' }));
    } catch {
      workers.length = 0;
    }
    this.prebakeWorkers = workers.length;
    if (workers.length === 0) {
      for (const j of todo) this.prebaked.set(bakeKey(j), runBake(j, this.rig));
    } else {
      let next = 0;
      await Promise.all(workers.map((w) => new Promise<void>((resolve, reject) => {
        const pump = (): void => {
          if (next >= todo.length) { resolve(); return; }
          const job = todo[next]!, seq = next++;
          w.onmessage = (e: MessageEvent<{ seq: number; baked: Baked }>): void => {
            this.prebaked.set(bakeKey(job), e.data.baked);
            pump();
          };
          w.onerror = (err): void => reject(new Error(`bake worker failed: ${err.message}`));
          w.postMessage({ seq, job, rig: this.rig });
        };
        pump();
      })));
      for (const w of workers) w.terminate();
    }
    this.prebakeMs = performance.now() - t0;
    if (persist && fresh.length > 0) {
      // Save in the background; a failure only means the next load re-bakes.
      // Copies, because packing may transfer or reuse the frame buffers.
      const entries: Array<[string, Baked]> = [];
      for (const k of fresh) {
        const b = this.prebaked.get(k);
        if (b) entries.push([storeKey(k, this.rig), { ...b, frames: b.frames.map((f) => ({ w: f.w, h: f.h, data: f.data.slice() })) }]);
      }
      void saveBakes(entries);
    }
  }

  /** A finished bake for `job`: prebaked if available, else baked now. */
  private baked(job: BakeJob): Baked {
    const k = bakeKey(job);
    const hit = this.prebaked.get(k);
    if (hit) { this.prebaked.delete(k); return hit; }
    return runBake(job, this.rig);
  }

  private shipFields(id: string, paint?: number): Fields {
    const k = `s:${id}:${paint ?? ''}`;
    let f = this.fieldCache.get(k);
    if (!f) { f = forgeShip(id, { ppu: shipPpu(id), paint }); this.fieldCache.set(k, f); }
    return f;
  }

  private structFields(id: string, seed: number, accent?: number): Fields {
    const k = `t:${id}:${seed}:${accent ?? ''}`;
    let f = this.fieldCache.get(k);
    if (!f) {
      f = forgeStructure(id, { ppu: STRUCT_PPU, maxSide: STRUCT_MAX_SIDE, seed, accent });
      this.fieldCache.set(k, f);
    }
    return f;
  }

  /** Map any placement seed onto one of the shared variants. */
  static variant(seed: number): number {
    return seedVariant(seed);
  }

  machinedShip(id: string, paint?: number): ShipArt {
    const job: BakeJob = { type: 'ship', id, paint };
    const key = bakeKey(job);
    const hit = this.ships.get(key);
    if (hit) return hit;
    const t0 = performance.now();
    const b = this.baked(job);
    const frames: Texture[] = [];
    for (let j = 0; j < b.frames.length; j++) this.smooth.add(b.frames[j]!, frames, j);
    this.smooth.commit();
    const art: ShipArt = { frames, w: b.w, h: b.h, density: b.density, nozzles: b.nozzles, navLights: b.navLights };
    this.ships.set(key, art);
    this.bakeMs.ships += performance.now() - t0;
    return art;
  }

  machinedStruct(id: string, rawSeed = 1, accent?: number): StructArt {
    const job: BakeJob = { type: 'struct', id, seed: seedVariant(rawSeed), accent };
    const key = bakeKey(job);
    const hit = this.structs.get(key);
    if (hit) return hit;
    const t0 = performance.now();
    const b = this.baked(job);
    const out: Texture[] = [];
    this.smooth.add(b.frames[0]!, out, 0);
    this.smooth.add(b.frames[1]!, out, 1);
    this.smooth.commit();
    const art: StructArt = { tex: out[0]!, albedo: out[1]!, w: b.w, h: b.h, density: b.density, navLights: b.navLights };
    this.structs.set(key, art);
    this.bakeMs.structures += performance.now() - t0;
    return art;
  }

  pixelShip(id: string, pd: number, s: PixelSettings, paint?: number): ShipArt {
    const key = `p:${id}:${paint ?? ''}:${pd.toFixed(4)}:${s.steps}:${s.dither}:${s.outline}`;
    const hit = this.ships.get(key);
    if (hit) return hit;
    const t0 = performance.now();
    const f = this.shipFields(id, paint);
    const frames: Texture[] = [];
    let size = 0;
    for (let k = 0; k < PIXEL_ROT_STEPS; k++) {
      const fr = pixelFrame(f, this.rig, { pd, steps: s.steps, dither: s.dither, outline: s.outline, rotation: (k / PIXEL_ROT_STEPS) * Math.PI * 2 });
      size = fr.w;
      this.pixel.add(fr, frames, k);
    }
    this.pixel.commit();
    const art: ShipArt = { frames, w: size, h: size, density: pd, nozzles: f.nozzles, navLights: f.navLights };
    this.ships.set(key, art);
    this.bakeMs.pixelShips += performance.now() - t0;
    return art;
  }

  pixelStruct(id: string, pd: number, s: PixelSettings, rawSeed = 1, accent?: number): StructArt {
    const seed = ArtCache.variant(rawSeed);
    const key = `p:${id}:${seed}:${accent ?? ''}:${pd.toFixed(4)}:${s.steps}:${s.dither}:${s.outline}`;
    const hit = this.structs.get(key);
    if (hit) return hit;
    const t0 = performance.now();
    const f = this.structFields(id, seed, accent);
    const fr = pixelFrame(f, this.rig, { pd, steps: s.steps, dither: s.dither, outline: s.outline, rotation: 0 });
    const out: Texture[] = [];
    this.pixel.add(fr, out, 0);
    this.pixel.commit();
    const art: StructArt = { tex: out[0]!, w: fr.w, h: fr.h, density: pd, navLights: f.navLights };
    this.structs.set(key, art);
    this.bakeMs.pixelStructures += performance.now() - t0;
    return art;
  }

  stats(): { smoothBytes: number; pixelBytes: number; smoothPages: number; pixelPages: number; bakeMs: ArtCache['bakeMs']; prebakeMs: number; prebakeWorkers: number; prebakeFromStore: number } {
    return {
      smoothBytes: this.smooth.bytes, pixelBytes: this.pixel.bytes, smoothPages: this.smooth.pageCount, pixelPages: this.pixel.pageCount,
      bakeMs: { ...this.bakeMs }, prebakeMs: this.prebakeMs, prebakeWorkers: this.prebakeWorkers, prebakeFromStore: this.prebakeFromStore,
    };
  }
}
