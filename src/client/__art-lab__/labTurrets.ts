/**
 * Art lab `?turrets=1` (machined): draw each hull's turrets as the game does
 * (ring cut into the hull bake, the baked gun at its mount's resting angle).
 * The Hangar's ship pictures (`pnpm ships:portraits`) use it. Split out of
 * main.ts (god-file cap): main.ts only calls these four.
 */
import { Container, Sprite, type Texture } from 'pixi.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipPrimaryColor } from '../../core/geometry/shipHullOutline.js';
import { isCapitalKind, type BakeJob } from '../render/art/bake.js';
import { MachinedShipSprite } from '../render/art/MachinedShipSprite.js';
import { applySunBlend } from '../render/art/machinedShipLight.js';
import { hasTurrets, shipTurrets, turretBakeJobs } from '../render/art/turretLayout.js';
import type { ArtCache, ShipArt } from './assets.js';

export interface LabGuns { root: Container; layers: Array<{ a: Sprite; b: Sprite; frames: Texture[]; rot: number }> }

/** Whether hull `id` draws turrets in this lab run (`on` = `?turrets=1` and machined). */
export function labTurreted(on: boolean, id: string): boolean {
  return on && hasTurrets(id, false);
}

function gunsOf(id: string, paint: number | undefined): Array<{ px: number; py: number; rot: number; jobs: ReturnType<typeof turretBakeJobs> }> {
  const color = paint ?? shipPrimaryColor(getShipKind(id));
  return shipTurrets(id).map((p) => ({ px: p.px, py: p.py, rot: -p.mount.baseAngle, jobs: turretBakeJobs(p, color, false) }));
}

/** The gun bake jobs for a turreted hull (prebaked with the hull). */
export function labGunJobs(id: string, paint: number | undefined): BakeJob[] {
  const jobs: BakeJob[] = [];
  for (const g of gunsOf(id, paint)) { jobs.push(g.jobs.gun); if (g.jobs.aa) jobs.push(g.jobs.aa.job); }
  return jobs;
}

/** Build a turreted hull's guns; add `root` to the hull so they ride it, as the game parents them. */
export function buildLabGuns(cache: ArtCache, id: string, paint: number | undefined): LabGuns {
  const root = new Container();
  const layers: LabGuns['layers'] = [];
  for (const g of gunsOf(id, paint)) {
    const pivot = new Container();
    pivot.position.set(g.px, g.py);
    pivot.rotation = g.rot;
    root.addChild(pivot);
    const put = (art: { frames: Texture[]; density: number }, x: number): void => {
      const a = new Sprite(art.frames[0]!), b = new Sprite(art.frames[1 % art.frames.length]!);
      for (const sp of [a, b]) { sp.anchor.set(0.5); sp.scale.set(1 / art.density); sp.x = x; pivot.addChild(sp); }
      layers.push({ a, b, frames: art.frames, rot: g.rot });
    };
    put(cache.machinedTurret(g.jobs.gun), 0);
    if (g.jobs.aa) { const aa = cache.machinedTurret(g.jobs.aa.job); for (const x of g.jobs.aa.xs) put(aa, x); }
  }
  return { root, layers };
}

/**
 * A machined hull as the game draws it: the game's hull sprite (it draws a
 * tiled capital whole, every tile, the capital sun steps, where a lone frame
 * pair showed only the bow), with its guns riding it when `turreted`.
 */
export function buildLabHull(cache: ArtCache, id: string, paint: number | undefined, turreted: boolean): { art: ShipArt; hull: MachinedShipSprite; guns?: LabGuns } {
  const art = cache.machinedShip(id, paint, turreted);
  const hull = new MachinedShipSprite(art, isCapitalKind(id));
  if (!turreted) return { art, hull };
  const guns = buildLabGuns(cache, id, paint);
  hull.addChild(guns.root);
  return { art, hull, guns };
}

/** Light each gun for the sun, at the hull's rotation. */
export function lightLabGuns(guns: LabGuns, sunAz: number, hullRot: number): void {
  for (const l of guns.layers) applySunBlend(l, l.frames, sunAz, hullRot + l.rot);
}
