/**
 * Rigs of structure family "heavyIndustry" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Heavy industry: ore processing complex, assembly plant, shipyard.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import { box, type PartDef, type RigDef } from '../rig.js';
import type { PlayingClip } from '../evaluate.js';
import type { RigKindMap } from './rigFamily.js';

// ── shipyard-frame (shipyard) ────────────────────────────────────────────────
//
// The owner-approved "build frame" (mock-up C, the capital frame built in
// blocks, scaled to SUB-CAPS) on the Shipyard's unchanged 960 × 600
// footprint. Game frame: x runs stern (-x) to bow (+x), the slipway down the
// middle (its mouth open at the bow); y is across. The body art bakes the
// deck, the sunken slipway, the wall tracks, the clamp ledges, the gantry
// rails and the stern headhouse (`structureStyleC.heavyIndustry.ts`); every
// piece that will move is a rig part here:
//  - two side WALLS (slides, out along ±y): they part to let a hull out;
//  - a GANTRY crane bridging the frame (a slide along x on the rails) with
//    its HOIST trolley (a lift, riding the gantry) that raises hull blocks;
//  - hull CLAMPS on the ledges either side of the slipway (hinges: folded
//    along the edge at rest, swung in across the slip to grip a hull);
//  - LIGHT strips down the slipway, stern to bow (static parts, numbered in
//    launch order so they can light in sequence).
// Every part is over-layer cosmetic: an outline on a cosmetic over part gets
// no collider (`rigBodies.ts` only builds plane parts), so the Shipyard's
// footprint collider is exactly what it was. The outlines size the parts for
// tests and the role fallback; the art is the family's `partArt`.
// No `idleClip`: with no clip record every part is at rest (walls shut,
// gantry parked at the stern, hoist down, clamps folded, lights dark).

/** Half extents of the slipway's clear channel (game units): the largest
 *  yard-built sub-cap (the missile frigate, radius 48 at ship scale 2) fits
 *  in it nose to tail with more than its own radius to spare on each side. */
export const SHIPYARD_SLIP_HALF_W = 100;
export const SHIPYARD_SLIP_X0 = -340;
export const SHIPYARD_SLIP_X1 = 450;

/** Side walls: centre line |y|, half thickness, half length, and how far
 *  each slides out when the frame opens. */
export const SHIPYARD_WALL_Y = 175;
export const SHIPYARD_WALL_HALF_T = 35;
export const SHIPYARD_WALL_HALF_L = 330;
export const SHIPYARD_WALL_TRAVEL = 50;

/** Gantry rails at |y|; the bridge's half width along x; its bogies' half
 *  width across the rail; travel along x (parked at the stern end). */
export const SHIPYARD_RAIL_Y = 270;
export const SHIPYARD_GANTRY_HALF_X = 30;
export const SHIPYARD_GANTRY_BOGIE = 14;
export const SHIPYARD_GANTRY_TRAVEL = 350;
/** Hoist trolley half size, and its lift at full rise (only a scale). */
export const SHIPYARD_HOIST_HALF = 26;
export const SHIPYARD_HOIST_LIFT = 1;

/** Hull clamps: stations along the slip, the ledge line |y| their pivots
 *  sit on, arm length and half width. Swung in, the tip sits at
 *  |y| = SHIPYARD_CLAMP_Y - SHIPYARD_CLAMP_LEN, just outside a frigate hull. */
export const SHIPYARD_CLAMP_XS = [-210, -70, 70, 210] as const;
export const SHIPYARD_CLAMP_Y = 118;
export const SHIPYARD_CLAMP_LEN = 48;
export const SHIPYARD_CLAMP_HALF_W = 7;

/** Light strips, stern to bow (launch order: `light-0` is the stern). Each
 *  is a pair of lamp bars, one inside each slip edge at |y| = BAR_Y. */
export const SHIPYARD_LIGHT_XS = [-270, -162, -54, 54, 162, 270] as const;
export const SHIPYARD_LIGHT_BAR_Y = 88;
export const SHIPYARD_LIGHT_HALF_L = 24;
export const SHIPYARD_LIGHT_HALF_T = 6;

/** The build clip, scrubbed by a 0..1 build progress (`shipyardBuildPlaying`). */
export const SHIPYARD_BUILD_CLIP = 'yard-build';
/** Length of the build clip in game ticks (progress 1 = its end). */
export const SHIPYARD_BUILD_TICKS = 600;

const lockedHinge = { type: 'hinge', min: 0, max: 0 } as const;

function wall(id: string, side: 1 | -1): PartDef {
  return {
    id, parent: null, anchorX: 0, anchorY: side * SHIPYARD_WALL_Y,
    joint: { type: 'slide', axisX: 0, axisY: side, min: 0, max: SHIPYARD_WALL_TRAVEL },
    rest: 0, layer: 'over', kind: 'cosmetic',
    outline: box(-SHIPYARD_WALL_HALF_L, -SHIPYARD_WALL_HALF_T, SHIPYARD_WALL_HALF_L, SHIPYARD_WALL_HALF_T),
  };
}

/** A clamp folded along its ledge (arm toward +x); swung in it turns a
 *  quarter toward the slip's centre line (port, +y: clockwise). */
function clamp(id: string, x: number, side: 1 | -1): PartDef {
  return {
    id, parent: null, anchorX: x, anchorY: side * SHIPYARD_CLAMP_Y,
    joint: side > 0 ? { type: 'hinge', min: -Math.PI / 2, max: 0 } : { type: 'hinge', min: 0, max: Math.PI / 2 },
    rest: 0, layer: 'over', kind: 'cosmetic',
    outline: box(0, -SHIPYARD_CLAMP_HALF_W, SHIPYARD_CLAMP_LEN, SHIPYARD_CLAMP_HALF_W),
  };
}

function light(i: number): PartDef {
  return {
    id: `light-${i}`, parent: null, anchorX: SHIPYARD_LIGHT_XS[i]!, anchorY: 0,
    joint: lockedHinge, rest: 0, layer: 'over', kind: 'cosmetic',
    outline: box(-SHIPYARD_LIGHT_HALF_L, -SHIPYARD_LIGHT_BAR_Y - SHIPYARD_LIGHT_HALF_T,
      SHIPYARD_LIGHT_HALF_L, SHIPYARD_LIGHT_BAR_Y + SHIPYARD_LIGHT_HALF_T),
  };
}

const CLAMP_IN = Math.PI / 2;
const T = SHIPYARD_BUILD_TICKS;

export const SHIPYARD_FRAME_DEF: RigDef = {
  id: 'shipyard-frame',
  // Draw order (over layer): lights under clamps, then walls, then the gantry.
  parts: [
    ...SHIPYARD_LIGHT_XS.map((_, i) => light(i)),
    ...SHIPYARD_CLAMP_XS.map((x, i) => clamp(`clamp-port-${i}`, x, 1)),
    ...SHIPYARD_CLAMP_XS.map((x, i) => clamp(`clamp-stbd-${i}`, x, -1)),
    wall('wall-port', 1),
    wall('wall-stbd', -1),
    {
      id: 'gantry', parent: null, anchorX: 0, anchorY: 0,
      joint: { type: 'slide', axisX: 1, axisY: 0, min: -SHIPYARD_GANTRY_TRAVEL, max: SHIPYARD_GANTRY_TRAVEL },
      rest: -SHIPYARD_GANTRY_TRAVEL, layer: 'over', kind: 'cosmetic',
      outline: box(-SHIPYARD_GANTRY_HALF_X, -SHIPYARD_RAIL_Y - SHIPYARD_GANTRY_BOGIE,
        SHIPYARD_GANTRY_HALF_X, SHIPYARD_RAIL_Y + SHIPYARD_GANTRY_BOGIE),
    },
    {
      // Not a root lift, so it is no pop-up riser: it rides the gantry.
      id: 'gantry-hoist', parent: 'gantry', anchorX: 0, anchorY: 0,
      joint: { type: 'lift', min: 0, max: SHIPYARD_HOIST_LIFT },
      rest: 0, layer: 'over', kind: 'cosmetic',
      outline: box(-SHIPYARD_HOIST_HALF, -SHIPYARD_HOIST_HALF, SHIPYARD_HOIST_HALF, SHIPYARD_HOIST_HALF),
    },
  ],
  clips: [
    {
      // A first pass for the build animation (job 3K retimes it): clamps
      // swing in, the gantry runs stern -> bow -> stern with the hoist up,
      // clamps let go, the walls part to release the hull.
      id: SHIPYARD_BUILD_CLIP,
      tracks: [
        ...SHIPYARD_CLAMP_XS.flatMap((_, i) => [
          { part: `clamp-port-${i}`, keys: [{ tick: 60, value: -CLAMP_IN }, { tick: 0.84 * T, value: -CLAMP_IN }, { tick: 0.92 * T, value: 0 }] },
          { part: `clamp-stbd-${i}`, keys: [{ tick: 60, value: CLAMP_IN }, { tick: 0.84 * T, value: CLAMP_IN }, { tick: 0.92 * T, value: 0 }] },
        ]),
        { part: 'gantry', keys: [{ tick: 60, value: -SHIPYARD_GANTRY_TRAVEL }, { tick: 0.5 * T, value: SHIPYARD_GANTRY_TRAVEL }, { tick: 0.84 * T, value: -SHIPYARD_GANTRY_TRAVEL }] },
        { part: 'gantry-hoist', keys: [{ tick: 80, value: 0 }, { tick: 120, value: SHIPYARD_HOIST_LIFT }, { tick: 0.78 * T, value: SHIPYARD_HOIST_LIFT }, { tick: 0.84 * T, value: 0 }] },
        { part: 'wall-port', keys: [{ tick: 0.88 * T, value: 0 }, { tick: T, value: SHIPYARD_WALL_TRAVEL }] },
        { part: 'wall-stbd', keys: [{ tick: 0.88 * T, value: 0 }, { tick: T, value: SHIPYARD_WALL_TRAVEL }] },
      ],
    },
  ],
};

/** The build clip scrubbed to `progress` (0..1, clamped) at `nowTick`:
 *  the clip record whose pose at `nowTick` is that point of the build.
 *  Writes into `out` (allocation-free; pass a reused record). */
export function shipyardBuildPlaying(progress: number, nowTick: number, out: { clipId: string; startTick: number }): PlayingClip {
  const p = progress > 1 ? 1 : progress > 0 ? progress : 0;
  out.clipId = SHIPYARD_BUILD_CLIP;
  out.startTick = nowTick - p * SHIPYARD_BUILD_TICKS;
  return out;
}

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [SHIPYARD_FRAME_DEF];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = { shipyard: 'shipyard-frame' };
