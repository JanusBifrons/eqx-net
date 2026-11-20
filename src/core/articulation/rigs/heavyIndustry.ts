/**
 * Rigs of structure family "heavyIndustry" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Heavy industry: ore processing complex, assembly plant, shipyard.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import { box, type KeyframeDef, type PartDef, type RigDef, type TrackDef } from '../rig.js';
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
// piece that will move or appear is a rig part here:
//  - two side WALLS (slides, out along ±y): they part to let a hull out;
//  - a GANTRY crane bridging the frame (a slide along x on the rails) with
//    its HOIST trolley (a lift, riding the gantry) that lowers hull blocks;
//  - hull CLAMPS on the ledges either side of the slipway (hinges: folded
//    along the edge at rest, swung in across the slip to grip a hull);
//  - a KEEL anchor at the slip centre (locked, no art) carrying the parts
//    that only appear: the HULL blocks and the FIT stages (lifts 0..1 =
//    printed in) and the LIGHT strips (lifts 0..1 = off .. on). They hang
//    off the keel so none is a root lift (a pop-up riser).
// Every part is over-layer cosmetic: an outline on a cosmetic over part gets
// no collider (`rigBodies.ts` only builds plane parts), so the Shipyard's
// footprint collider is exactly what it was. The outlines size the parts for
// tests and the role fallback; the art is the family's `partArt`, and how a
// lift value shows (print fade, lamp lit, hull scale) its `partShow`.
// No `idleClip`: with no clip record every part is at rest (walls shut,
// gantry parked at the stern, hoist down, clamps folded, lights dark, no hull).

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

/** The generic hull the yard prints, at its REFERENCE size (the largest
 *  sub-cap's radius as its half length; the client scales it to the kind
 *  being built, `structureStyleC.shipyardBuild.ts`): half length, half beam
 *  amidships, and the number of blocks it is printed in. */
export const SHIPYARD_HULL_HALF_L = 48;
export const SHIPYARD_HULL_HALF_W = 18;
export const SHIPYARD_HULL_BLOCKS = 8;
const BLOCK_LEN = (2 * SHIPYARD_HULL_HALF_L) / SHIPYARD_HULL_BLOCKS;

/** The hull's half beam at x (reference frame): full amidships, a slight
 *  stern taper, a long bow taper to a narrow nose. */
export function shipyardHullHalfBeam(x: number): number {
  const u = x / SHIPYARD_HULL_HALF_L;
  const k = u > 0.2 ? 1 - ((u - 0.2) / 0.8) * 0.7 : u < -0.75 ? 1 - ((-0.75 - u) / 0.25) * 0.15 : 1;
  return SHIPYARD_HULL_HALF_W * k;
}

/** Hull block centres (x) in PRINT order: middle out, alternating the bow
 *  side and the stern side of amidships (`hull-0` is just bow of the middle). */
export const SHIPYARD_HULL_BLOCK_XS: readonly number[] = Array.from({ length: SHIPYARD_HULL_BLOCKS }, (_, j) =>
  (j % 2 === 0 ? 1 : -1) * (Math.floor(j / 2) + 0.5) * BLOCK_LEN);

/** Fit stages, in fitting order, each a part `fit-<id>` printed in at its
 *  station x (reference frame) once every hull block is down. */
export const SHIPYARD_FIT_STAGES = ['deck', 'hardpoints', 'superstructure', 'engines', 'weapons'] as const;
export type ShipyardFitStage = (typeof SHIPYARD_FIT_STAGES)[number];
export const SHIPYARD_FIT_X: Readonly<Record<ShipyardFitStage, number>> = {
  deck: 0, hardpoints: 4, superstructure: -16, engines: -44, weapons: 24,
};
/** Each fit stage's outline half extents (x, y) about its station. */
const FIT_HALF: Readonly<Record<ShipyardFitStage, readonly [number, number]>> = {
  deck: [36, 11], hardpoints: [26, 14], superstructure: [10, 8], engines: [7, 14], weapons: [10, 12],
};

/** The build clip, scrubbed by a 0..1 build progress (`shipyardBuildPlaying`). */
export const SHIPYARD_BUILD_CLIP = 'yard-build';
/** Length of the build clip in game ticks (progress 1 = its end). */
export const SHIPYARD_BUILD_TICKS = 600;

/** The build sequence's beats (ticks into the clip), in order (job 3K,
 *  mock-up C): the clamps swing in; the gantry lowers the hull blocks middle
 *  out; the fit stages go on; the lights come on BOW to stern; the clamps
 *  let go and the walls part, leaving the finished hull sitting in the slip. */
export const SHIPYARD_BUILD_BEATS = {
  clampsIn: 50,
  blocksFrom: 70, blockStep: 28,
  fitFrom: 300, fitStep: 32,
  gantryParked: 490,
  lightsFrom: 480, lightStep: 10,
  clampsOpenFrom: 545, clampsOpen: 575,
  wallsFrom: 565,
} as const;

const lockedHinge = { type: 'hinge', min: 0, max: 0 } as const;
const showLift = { type: 'lift', min: 0, max: 1 } as const;

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

/** A part on the keel that only appears (lift 0 hidden .. 1 shown). */
function shown(id: string, x: number, outline: readonly number[]): PartDef {
  return { id, parent: 'keel', anchorX: x, anchorY: 0, joint: showLift, rest: 0, layer: 'over', kind: 'cosmetic', outline };
}

function light(i: number): PartDef {
  return shown(`light-${i}`, SHIPYARD_LIGHT_XS[i]!, box(-SHIPYARD_LIGHT_HALF_L, -SHIPYARD_LIGHT_BAR_Y - SHIPYARD_LIGHT_HALF_T,
    SHIPYARD_LIGHT_HALF_L, SHIPYARD_LIGHT_BAR_Y + SHIPYARD_LIGHT_HALF_T));
}

/** Hull block `j` (print order): a trapezoid following the beam profile. */
function hullBlock(j: number): PartDef {
  const xc = SHIPYARD_HULL_BLOCK_XS[j]!, h = BLOCK_LEN / 2;
  const w0 = shipyardHullHalfBeam(xc - h), w1 = shipyardHullHalfBeam(xc + h);
  return shown(`hull-${j}`, xc, [-h, -w0, h, -w1, h, w1, -h, w0]);
}

function fit(s: ShipyardFitStage): PartDef {
  const [hx, hy] = FIT_HALF[s];
  return shown(`fit-${s}`, SHIPYARD_FIT_X[s], box(-hx, -hy, hx, hy));
}

const CLAMP_IN = Math.PI / 2;
const T = SHIPYARD_BUILD_TICKS;
const B = SHIPYARD_BUILD_BEATS;
/** The hoist's lift while it sets a block down (1 = carrying, up). */
const HOIST_SET = 0.35;

/** The build clip's gantry, hoist and print tracks: for each station x in
 *  `xs` (one beat of `step` ticks from `from`), the gantry runs there, the
 *  hoist lowers, the station's part prints in (0 -> 1), the hoist rises. */
function stationTracks(parts: readonly string[], xs: readonly number[], from: number, step: number,
  gantry: KeyframeDef[], hoist: KeyframeDef[]): TrackDef[] {
  return parts.map((part, j) => {
    const t0 = from + j * step;
    gantry.push({ tick: t0, value: xs[j]! }, { tick: t0 + step - 8, value: xs[j]! });
    hoist.push({ tick: t0, value: SHIPYARD_HOIST_LIFT }, { tick: t0 + 8, value: HOIST_SET },
      { tick: t0 + step - 10, value: HOIST_SET }, { tick: t0 + step - 2, value: SHIPYARD_HOIST_LIFT });
    return { part, keys: [{ tick: t0 + 6, value: 0 }, { tick: t0 + step - 10, value: 1, ease: 'linear' }] };
  });
}

function buildTracks(): TrackDef[] {
  const gantry: KeyframeDef[] = [], hoist: KeyframeDef[] = [];
  const hull = stationTracks(SHIPYARD_HULL_BLOCK_XS.map((_, j) => `hull-${j}`), SHIPYARD_HULL_BLOCK_XS,
    B.blocksFrom, B.blockStep, gantry, hoist);
  const fits = stationTracks(SHIPYARD_FIT_STAGES.map((s) => `fit-${s}`), SHIPYARD_FIT_STAGES.map((s) => SHIPYARD_FIT_X[s]),
    B.fitFrom, B.fitStep, gantry, hoist);
  gantry.push({ tick: B.gantryParked, value: -SHIPYARD_GANTRY_TRAVEL });
  hoist.push({ tick: B.gantryParked, value: 0 });
  // Bow to stern: light-5 (the bow strip) first, light-0 (the stern) last.
  const lights = SHIPYARD_LIGHT_XS.map((_, i): TrackDef => {
    const t0 = B.lightsFrom + (SHIPYARD_LIGHT_XS.length - 1 - i) * B.lightStep;
    return { part: `light-${i}`, keys: [{ tick: t0, value: 0 }, { tick: t0 + 6, value: 1, ease: 'linear' }] };
  });
  return [
    ...SHIPYARD_CLAMP_XS.flatMap((_, i) => [
      { part: `clamp-port-${i}`, keys: [{ tick: B.clampsIn, value: -CLAMP_IN }, { tick: B.clampsOpenFrom, value: -CLAMP_IN }, { tick: B.clampsOpen, value: 0 }] },
      { part: `clamp-stbd-${i}`, keys: [{ tick: B.clampsIn, value: CLAMP_IN }, { tick: B.clampsOpenFrom, value: CLAMP_IN }, { tick: B.clampsOpen, value: 0 }] },
    ]),
    ...hull, ...fits, ...lights,
    { part: 'gantry', keys: gantry },
    { part: 'gantry-hoist', keys: hoist },
    { part: 'wall-port', keys: [{ tick: B.wallsFrom, value: 0 }, { tick: T, value: SHIPYARD_WALL_TRAVEL }] },
    { part: 'wall-stbd', keys: [{ tick: B.wallsFrom, value: 0 }, { tick: T, value: SHIPYARD_WALL_TRAVEL }] },
  ];
}

export const SHIPYARD_FRAME_DEF: RigDef = {
  id: 'shipyard-frame',
  // Draw order (over layer): lights, the hull and its fittings, clamps, walls, the gantry.
  parts: [
    { id: 'keel', parent: null, anchorX: 0, anchorY: 0, joint: lockedHinge, rest: 0, layer: 'over', kind: 'cosmetic', outline: box(-2, -2, 2, 2) },
    ...SHIPYARD_LIGHT_XS.map((_, i) => light(i)),
    ...SHIPYARD_HULL_BLOCK_XS.map((_, j) => hullBlock(j)),
    ...SHIPYARD_FIT_STAGES.map(fit),
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
  clips: [{ id: SHIPYARD_BUILD_CLIP, tracks: buildTracks() }],
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
