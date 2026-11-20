/**
 * Art lab view records (split out of `main.ts`): the sprites each scene
 * entity owns, all created up front and only mutated per frame.
 */
import type { Container, Graphics, Sprite } from 'pixi.js';
import type { StructArt, ShipArt } from './assets.js';
import type { Pose, ShipE, Shot } from './scenes.js';
import type { LitShipMesh } from '../render/art/litShipShader.js';
import type { MachinedShipSprite } from '../render/art/MachinedShipSprite.js';
import type { LabGuns } from './labTurrets.js';

export interface ShipView {
  e: ShipE;
  pose: Pose;
  /** Machined: two cross-faded lit frames. Pixel: `a` only. Current: unused. */
  a: Sprite;
  b: Sprite;
  gfx: Graphics | null;
  /** Machined: the hull (the game's sprite; tiles a capital). */
  hull?: MachinedShipSprite;
  /** `?turrets=1`: the hull's guns, posed with it (sun frames per gun). */
  guns?: LabGuns;
  /** `lit` style: the GPU-lit hull. */
  lit?: LitShipMesh;
  /** `lit` style: a big hull that shades others (box half size, height). */
  occ?: { hx: number; hy: number; h: number; color: number };
  trails: Sprite[];
  nozzles: Sprite[];
  navs: Sprite[];
  art: ShipArt | null;
  /** Pixel art per zoom band (index = band + BAND_OFFSET). */
  bandArt: Array<ShipArt | undefined>;
  phase: number;
  /** FxEngines key (the game's exhaust: flames + ribbons). */
  fxKey: string;
}

export interface StructView {
  x: number; y: number;
  sprite: Sprite | null;
  gfx: Graphics | null;
  /** Machined: albedo copy, added on top when an explosion lights the area. */
  lit: Sprite | null;
  /** `lit` style with live-lit structures: the GPU-lit structure. */
  litMesh?: LitShipMesh;
  rot: number;
  lamps: Sprite[];
  lampXY: Array<{ x: number; y: number }>;
  art: StructArt | null;
  bandArt: Array<StructArt | undefined>;
  id: string; seed: number;
  radius: number;
}

export interface BoomView {
  flash: Sprite; ring: Sprite; pool: Sprite; balls: Sprite[];
  x: number; y: number; t0: number; size: number;
}

/** One weapon stream's sprites, all created up front. */
export interface ShotView {
  s: Shot;
  core: Sprite; halo: Sprite; flare: Sprite; rim: Sprite; flash: Sprite;
  bolts: Sprite[]; sparks: Sprite[];
}
export const SPARKS = 6;

export const BAND_OFFSET = 40;
export const BALLS = 14;

export function countSprites(c: Container): number {
  let n = 0;
  for (const ch of c.children) n += 1 + countSprites(ch as Container);
  return n;
}
