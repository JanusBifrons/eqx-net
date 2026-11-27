/**
 * Lit deck (`?deckLit=on`, .resume/deck-lit-plan.md slice 3): the road lamps
 * light the deck. Each lamp the road overlay draws (`roadOverlayPlan(...).lamps`)
 * becomes a low, soft amber point light in the lit pass, fed by
 * `feedLitScene` like weapons fire and blasts (no third light path).
 *
 * The lamp table is rebuilt with the road joins (`roadJoins.ts` `rebuild`,
 * cold: only when a road or gate changes), in Pixi space from each road's
 * UNMIRRORED arm mask (the same world geometry as the mirrored overlay).
 * Per frame, {@link addRoadLampLights} adds only the on-screen lamps, up to a
 * cap, and allocates nothing (#14).
 *
 * The dark deck needs a bright lamp to show a pool (the shader scales a light
 * by the albedo), but lit meshes keep only their strongest few lights
 * (`strongestLightsInto`, 4 on phones): a lamp is added with a low `rank`, so
 * when picking, a shell (0.9) or a blast (3) still beats it (1.8 × 0.25).
 */
import type { LitScene } from '../art/litShipShader.js';
import { roadOverlayPlan } from './structureStyleC.transport.road.js';
import type { RoadPiece } from './roadJoins.js';

/** How a road lamp lights (Pixi space; z and reach in world units). */
export const ROAD_LAMP_LIGHT = { z: 30, color: 0xffb060, intensity: 1.8, reach: 280, rank: 0.25 } as const;
/** At most this many lamps light a frame: the on-screen ones nearest the view centre. */
export const ROAD_LAMP_CAP = 32;

/** Scratch for the nearest-first pick (lamp index, squared distance). */
const _pick = new Int32Array(ROAD_LAMP_CAP);
const _pickD = new Float64Array(ROAD_LAMP_CAP);

let lampXY = new Float32Array(64);
let lampCount = 0;

/** Rebuild the lamp table (cold): every road's lamps in Pixi space.
 *  `arms`: road id → its UNMIRRORED local arm mask (`LIT_ARMS`). */
export function rebuildRoadLamps(roads: readonly RoadPiece[], arms: ReadonlyMap<number, number>): void {
  lampCount = 0;
  const plans = new Map<number, number[]>();
  for (const p of roads) {
    const mask = arms.get(p.id);
    if (mask === undefined) continue;
    let l = plans.get(mask);
    if (l === undefined) { l = roadOverlayPlan(mask).lamps; plans.set(mask, l); }
    // Sprite: rotation = -angle, at (x, -y) (unmirrored frame: the mask already is).
    const rot = (-p.rotDeg * Math.PI) / 180, c = Math.cos(rot), s = Math.sin(rot);
    const px = p.x, py = -p.y;
    for (let i = 0; i < l.length; i += 2) {
      const lx = l[i]!, ly = l[i + 1]!;
      if (lampCount * 2 + 2 > lampXY.length) { const n = new Float32Array(lampXY.length * 2); n.set(lampXY); lampXY = n; }
      lampXY[lampCount * 2] = px + lx * c - ly * s;
      lampXY[lampCount * 2 + 1] = py + lx * s + ly * c;
      lampCount++;
    }
  }
}

/** Forget the table (sector handoff, tests). */
export function resetRoadLamps(): void { lampCount = 0; }

/** The lamp table (Pixi x, y pairs; tests read it). */
export function roadLamps(): { xy: Float32Array; count: number } { return { xy: lampXY, count: lampCount }; }

/** Add the on-screen lamps (padded by their reach) to `scene`: at most
 *  `cap` (≤ ROAD_LAMP_CAP), the nearest the view centre first, so a wide
 *  view lights the lamps round the player, not whichever came first in the
 *  table. `bounds`: the camera rect (`Camera.visibleBoundsInto`). Alloc-free. */
export function addRoadLampLights(scene: Pick<LitScene, 'addLight'>, bounds: Float64Array | undefined, cap = ROAD_LAMP_CAP): number {
  const L = ROAD_LAMP_LIGHT, r = L.reach;
  const n = Math.min(cap, ROAD_LAMP_CAP);
  const cx = bounds !== undefined ? (bounds[0]! + bounds[2]!) / 2 : 0, cy = bounds !== undefined ? (bounds[1]! + bounds[3]!) / 2 : 0;
  let k = 0;
  for (let i = 0; i < lampCount; i++) {
    const x = lampXY[i * 2]!, y = lampXY[i * 2 + 1]!;
    if (bounds !== undefined && (x + r < bounds[0]! || x - r > bounds[2]! || y + r < bounds[1]! || y - r > bounds[3]!)) continue;
    const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    let j: number;
    if (k < n) j = k++;
    else { if (d >= _pickD[n - 1]!) continue; j = n - 1; }
    while (j > 0 && _pickD[j - 1]! > d) { _pickD[j] = _pickD[j - 1]!; _pick[j] = _pick[j - 1]!; j--; }
    _pickD[j] = d; _pick[j] = i;
  }
  for (let j = 0; j < k; j++) {
    const i = _pick[j]!;
    scene.addLight(lampXY[i * 2]!, lampXY[i * 2 + 1]!, L.z, L.color, L.intensity, r, -1, L.rank);
  }
  return k;
}
