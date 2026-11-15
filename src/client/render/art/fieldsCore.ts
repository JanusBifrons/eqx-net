/**
 * Machined art: the shared field-set primitives (material ids, the field set,
 * colour and noise helpers) that the ship, structure and livery forges build on.
 */
import type { LiveryEdge } from '../../../shared-types/factions.js';
import type { BowFeature } from './bowDetail.js';
import type { Grid } from './raster.js';

export const MAT = {
  NONE: 0,
  METAL: 1,
  PAINT: 2,
  TRIM: 3,
  GLASS: 4,
  NOZZLE: 5,
  LIGHT: 6,
  WINDOW: 7,
  ROCK: 8,
  /** Owner-faction enamel on a liveried hull (written only via `paintLivery`). */
  LIVERY: 9,
} as const;

/** Which spot treatment a livery uses. 'b2' / 'b3': treatment 'b''s spots
 *  with a shade experiment (`LIVERY_SHADES`). 'b4': B3's sub-cap shade and
 *  B2's capital paint on a new layout (`forgeShip`, "Treatment 'b4'").
 *  'b5' / 'b6' / 'b7': B4 with a forced section-edge shape (`B4_EDGE`:
 *  swept, tongue, dog-tooth). 'b8': B4 with the owner faction's own edge
 *  (`Livery.edge`, `teamEdgeOf`). */
export type LiveryTreatment = 'a' | 'b' | 'c' | 'b2' | 'b3' | 'b4' | 'b5' | 'b6' | 'b7' | 'b8';
export type { LiveryEdge };
/** A ship livery: grey hull, the owner's colours only in chosen spots. */
export interface Livery {
  treatment: LiveryTreatment;
  /** Team colour, sRGB hex. */
  team: number;
  /** Sigil seed (per faction): picks the emblem `sigilDesign` draws in
   *  treatment 'c' (in the team colour). */
  sigil: number;
  /** The faction's section-edge shape (treatment 'b8'; 'tongue' if absent). */
  edge?: LiveryEdge;
}

export interface Fields {
  g: Grid;
  /** Coverage 0..1. */
  cov: Float32Array;
  /** Height, world units. */
  height: Float32Array;
  /** Material id per texel (MAT). */
  mat: Uint8Array;
  /** Linear-RGB albedo, 3 floats per texel. */
  albedo: Float32Array;
  /** Linear-RGB emission, 3 floats per texel. */
  emis: Float32Array;
  /** sRGB hex of the material's base colour per texel: the pixel look's ramp
   *  key (so grime and panel jitter never split a surface into many ramps). */
  key: Uint32Array;
  /** The paint colour this set was built with (for faction tints / ramps). */
  paint: number;
  /** Nav lights + nozzles in local world units (runtime glow sprites). */
  navLights: Array<{ x: number; y: number; color: number }>;
  nozzles: Array<{ x: number; y: number; r: number; len?: number }>;
  /** Hull vent slits drawn (centre + half extents, local world units; ships). */
  vents?: Array<{ x: number; y: number; hw: number; hh: number }>;
  /** Capital bow fittings stamped into the hull (bowDetail.ts; ships). */
  bow?: BowFeature[];
  /** The livery this set was forged with (ships; absent = catalogue paint). */
  livery?: Livery;
  /** Treatment 'c' emblems stamped (centre + radius, local world units). */
  sigils?: Array<{ x: number; y: number; r: number; kind: 'sigil' | 'chevron' }>;
}

/** sRGB hex → linear rgb. */
export function lin(hex: number): [number, number, number] {
  const f = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}

export function newFields(g: Grid, paint: number): Fields {
  const n = g.w * g.h;
  return {
    g,
    cov: new Float32Array(n),
    height: new Float32Array(n),
    mat: new Uint8Array(n),
    albedo: new Float32Array(n * 3),
    emis: new Float32Array(n * 3),
    key: new Uint32Array(n),
    paint,
    navLights: [],
    nozzles: [],
  };
}

export function setAlbedo(f: Fields, i: number, c: readonly number[], k = 1): void {
  f.albedo[i * 3] = c[0]! * k;
  f.albedo[i * 3 + 1] = c[1]! * k;
  f.albedo[i * 3 + 2] = c[2]! * k;
}

/** Hull metal, trim and glass base colours (sRGB). One shared material set so
 *  every ship and structure reads as one universe. */
export const PALETTE = {
  metal: 0x737c8b,
  metalWorn: 0xb4bcc8,
  trim: 0x262b34,
  glass: 0x123247,
  nozzle: 0x1b1c22,
  engine: 0xffa24a,
  navPort: 0xff3b3b,
  navStarboard: 0x3bff7a,
};

/** Pull a colour toward its channel mean by `s`, then darken by `d`. */
export function muted(hex: number, s: number, d: number): number {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const grey = (r + g + b) / 3;
  const m = (c: number): number => Math.round(Math.max(0, Math.min(255, (grey + (c - grey) * s) * d)));
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

/** Soften a catalogue colour into a paint: less neon, a touch darker. */
export function paintOf(hex: number): number {
  return muted(hex, 0.78, 0.86);
}

/** Hash of an integer to 0..1. */
export function hash01(a: number, seed: number): number {
  let h = Math.imul(a ^ seed, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Hashed value noise in 0..1 (smooth, cheap). */
function latticeHash(a: number, b: number, seed: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const a = latticeHash(xi, yi, seed), b = latticeHash(xi + 1, yi, seed);
  const c = latticeHash(xi, yi + 1, seed), d = latticeHash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
