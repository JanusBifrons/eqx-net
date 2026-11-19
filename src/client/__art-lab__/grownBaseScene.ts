/**
 * Art lab `scene=base`: the real base generator's output (structure restyle
 * Stage 4 Phase 0b), so every checkpoint shows a base the game would grow.
 * `?tier=` / `?role=` / `?seed=` pick it (`labSceneParams.ts`); the camera
 * frames `grownExtent` (structures plus dock pads) into the view.
 *
 * Game space is y-up and the lab's scene space is Pixi (y down), so a
 * placement (x, y, rot°) lands at (x, -y, -rot in radians).
 */
import { growBase, type GrownBase } from '../../core/bases/growBase.js';
import { TIER_LEVEL_CAP, TIER_WEALTH, type BaseProfile } from '../../core/bases/baseProfile.js';
import { grownExtent } from '../../core/bases/baseSite.js';
import type { GrownBaseParams } from './labSceneParams.js';
import { flyer, type Scene, type ShipE, type StructE, type View } from './scenes.js';

/** A hand-built profile at the tier's mid wealth and top level cap, fenced
 *  (the generator's usual case). */
export function labBaseProfile(p: GrownBaseParams): BaseProfile {
  const [w0, w1] = TIER_WEALTH[p.tier];
  return { tier: p.tier, role: p.role, ownerFaction: 'traders', wealth: Math.round((w0 + w1) / 2), levelCap: TIER_LEVEL_CAP[p.tier][1], fenced: true };
}

export function growLabBase(p: GrownBaseParams): GrownBase {
  return growBase(labBaseProfile(p), p.seed);
}

export function grownBaseScene(p: GrownBaseParams, view: View, zoomOr: (z: number) => number): Scene {
  const grown = growLabBase(p);
  const structs: StructE[] = grown.placements.map((pl, i) => ({ id: pl.kind, x: pl.x, y: -pl.y, rot: -((pl.rot ?? 0) * Math.PI) / 180, seed: 1 + i }));
  const edges = grown.edges.map(([a, b]): [number, number] => [a, b]);
  const e = grownExtent(grown.placements);
  // Pixi y = -game y: the extent's centre flips too.
  const cx = (e.x0 + e.x1) / 2, cy = -(e.y0 + e.y1) / 2;
  // Scale ships: a heavy, two fighters and a hauler crossing the base's
  // middle, left to right over the scene's duration (the `fleet-pass` clip).
  const span = e.x1 - e.x0, DUR = 10;
  const lane = (dy: number, lag: number) => (t: number): [number, number] => [e.x0 - 200 + ((t - lag) / DUR) * (span + 400), cy + dy];
  const ships: ShipE[] = [flyer('heavy', lane(0, 0)), flyer('fighter', lane(-60, 0.4)), flyer('fighter', lane(60, 0.4)), flyer('trader-hauler', lane(160, 1))];
  const zoom = Math.min((view.w * 0.92) / Math.max(1, e.x1 - e.x0), (view.h * 0.92) / Math.max(1, e.y1 - e.y0));
  return { ships, structs, edges, booms: [], duration: DUR, camera: (_t, c) => { c.x = cx; c.y = cy; c.zoom = zoomOr(zoom); } };
}
