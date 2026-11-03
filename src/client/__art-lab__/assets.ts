/**
 * Art lab — baked art per style, cached by kind (+ zoom level and settings for
 * the pixel look). Bake time and atlas bytes are tallied for the bench.
 */
import type { Texture } from 'pixi.js';
import { Atlas } from './atlas.js';
import { forgeShip, forgeStructure, type Fields } from './forge/fields.js';
import { DEFAULT_RIG, litFrame, pixelFrame, type Frame, type LightRig } from './forge/shade.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { linToSrgb } from './forge/palette.js';

/** Machined ships keep this many sun azimuths and cross-fade between two. */
export const SUN_STEPS = 16;
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

function shipPpu(id: string): number {
  return getShipKind(id).radius >= 25 ? 3 : 4;
}

function albedoFrame(f: Fields): Frame {
  const n = f.g.w * f.g.h;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const a = f.cov[i]!;
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(linToSrgb(f.albedo[i * 3 + c]! * 1.4) * 255);
    data[i * 4 + 3] = Math.round(a * 255);
  }
  return { w: f.g.w, h: f.g.h, data };
}

export class ArtCache {
  readonly smooth = new Atlas(false);
  readonly pixel = new Atlas(true);
  readonly bakeMs = { ships: 0, structures: 0, pixelShips: 0, pixelStructures: 0 };
  private ships = new Map<string, ShipArt>();
  private structs = new Map<string, StructArt>();
  private fieldCache = new Map<string, Fields>();
  rig: LightRig = DEFAULT_RIG;

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
      // Keep the biggest pads inside one atlas page.
      const ppu = id.startsWith('teleporter') ? 1.2 : 1.5;
      f = forgeStructure(id, { ppu, seed, accent });
      this.fieldCache.set(k, f);
    }
    return f;
  }

  machinedShip(id: string, paint?: number): ShipArt {
    const key = `${id}:${paint ?? ''}`;
    const hit = this.ships.get(`m:${key}`);
    if (hit) return hit;
    const t0 = performance.now();
    const f = this.shipFields(id, paint);
    const frames: Texture[] = [];
    for (let j = 0; j < SUN_STEPS; j++) this.smooth.add(litFrame(f, this.rig, (j / SUN_STEPS) * Math.PI * 2), frames, j);
    this.smooth.commit();
    const art: ShipArt = { frames, w: f.g.w, h: f.g.h, density: f.g.ppu, nozzles: f.nozzles, navLights: f.navLights };
    this.ships.set(`m:${key}`, art);
    this.bakeMs.ships += performance.now() - t0;
    return art;
  }

  machinedStruct(id: string, seed = 1, accent?: number): StructArt {
    const key = `m:${id}:${seed}:${accent ?? ''}`;
    const hit = this.structs.get(key);
    if (hit) return hit;
    const t0 = performance.now();
    const f = this.structFields(id, seed, accent);
    const out: Texture[] = [];
    this.smooth.add(litFrame(f, this.rig, this.rig.sunAz), out, 0);
    this.smooth.add(albedoFrame(f), out, 1);
    this.smooth.commit();
    const art: StructArt = { tex: out[0]!, albedo: out[1]!, w: f.g.w, h: f.g.h, density: f.g.ppu, navLights: f.navLights };
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

  pixelStruct(id: string, pd: number, s: PixelSettings, seed = 1, accent?: number): StructArt {
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

  stats(): { smoothBytes: number; pixelBytes: number; smoothPages: number; pixelPages: number; bakeMs: ArtCache['bakeMs'] } {
    return { smoothBytes: this.smooth.bytes, pixelBytes: this.pixel.bytes, smoothPages: this.smooth.pageCount, pixelPages: this.pixel.pageCount, bakeMs: { ...this.bakeMs } };
  }
}
