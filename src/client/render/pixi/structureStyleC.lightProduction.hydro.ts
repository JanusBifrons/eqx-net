/**
 * Style C family "lightProduction": the hydroponics bay and the fabricator
 * (docs/plans/structure-restyle-stage4.md §6). Same vocabulary and density as
 * the refinery (structureStyleC.lightProduction.ts); the work glow is the
 * family's shared one (structureStyleC.lightProduction.work.ts): panes baked
 * dark here (`bakeSlits`), lit only while the building works, the red
 * no-supply mark while it is starved (`workGlowStatus`). `kinds` and
 * `status` are spread into the family's tables.
 */
import {
  CRANE, HAZARD, LAMP_AMBER, LAMP_WHITE, RIVET, SLAB, SLAB_DARK, SLAB_LIGHT, STEEL, chamferBox, chevron, core, deck,
  grime, lamp, ngon, poly, rivets, scaffold, stencil, strip, strut, truss, walkway, weld, wornStripe,
  type Pt, type Pts, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { BodyStatusHookTable } from './structureSocketNubs.js';
import { bakeSlits, workGlowStatus, type WorkMark, type WorkSlit } from './structureStyleC.lightProduction.work.js';

// ── Hydroponics bay (420 × 200) ─────────────────────────────────────────────

/** Unlit grow-bay glazing: near-black glass with a green cast. */
const GROW_GLASS = 0x16201b;
/** Nutrient tank shell: olive drab. */
const NUTRIENT = 0x343c2c;
/** Grow-bay trough centre lines (px, +y down). */
const TROUGH_YS = [-54, 0, 54] as const;
const TROUGH_X0 = -132, TROUGH_X1 = 122;

/** The hydroponics grow-light strips (x, y, w, h in px, the drawer's frame):
 *  two on the outer troughs' roof ridges, one on the middle trough's.
 *  Baked as dead glass; the live overlay lights them while it works. */
export const HYDROPONICS_SLITS: ReadonlyArray<WorkSlit> = [
  [-104, -56, 44, 4], [56, -56, 44, 4], [-22, -2, 44, 4], [-104, 52, 44, 4], [56, 52, 44, 4],
];

/** The starved hydroponics bay's red no-supply mark: on the pump house's open
 *  face, below its scaffold and above the livery sigil (x, y, half height, stroke; px). */
export const HYDROPONICS_MARK: WorkMark = [-171, -12, 12, 3];

/** One grow-bay trough centred on `y0`: a dark trough slab, a glazed roof
 *  (green-black glass) with a steel frame, cross mullions and a ridge bar. */
function trough(c: StyleCtx, y0: number): void {
  core(c, chamferBox(TROUGH_X0, y0 - 20, TROUGH_X1 - TROUGH_X0, 40, 6), SLAB_DARK, 10, 0);
  poly(c, chamferBox(TROUGH_X0 + 4, y0 - 15, TROUGH_X1 - TROUGH_X0 - 8, 30, 4), GROW_GLASS, 'metal', 14, 1.5);
  for (const s of [-1, 1]) poly(c, strip([TROUGH_X0 + 4, y0 + s * 15], [TROUGH_X1 - 4, y0 + s * 15], 2.4), STEEL, 'metal', 16, 0.8);
  for (let x = TROUGH_X0 + 26; x < TROUGH_X1 - 4; x += 22) poly(c, strip([x, y0 - 15], [x, y0 + 15], 2), STEEL, 'metal', 16, 0.7);
  poly(c, strip([TROUGH_X0 + 4, y0], [TROUGH_X1 - 4, y0], 1.6), RIVET, 'metal', 17, 0.5);
}

/** Hydroponics bay: three long grow-bay troughs under glazed, mullioned
 *  roofs, a pump house at one end piped into each trough, two olive
 *  nutrient tanks on a manifold at the other, pipe-rack trusses along the
 *  long edges, grow-light strips on the roof ridges (baked dark, lit by the
 *  live overlay while it works, `status`). */
function hydroponics(c: StyleCtx): void {
  deck(c);
  grime(c, -200, -92, 400, 184, 12, 6);
  for (const s of [-1, 1]) truss(c, [-140, s * 88], [116, s * 88], 16, STEEL, 10);
  for (const s of [-1, 1]) walkway(c, [TROUGH_X0, s * 27], [TROUGH_X1, s * 27], 10);
  // Pump house: the ice melt and dosing pumps, piped into every trough.
  const pump = core(c, chamferBox(-198, -62, 54, 124, 10), SLAB, 22, Math.PI / 2);
  wornStripe(c, pump, Math.PI / 2, 47, 8, 33);
  weld(c, [-190, 8], [-152, 8]);
  rivets(c, [-190, 56], [-152, 56], 10);
  for (const y0 of TROUGH_YS) strut(c, [-144, y0], [TROUGH_X0, y0], 8, 12);
  for (const y0 of TROUGH_YS) trough(c, y0);
  bakeSlits(c, HYDROPONICS_SLITS);
  // Nutrient manifold and tanks.
  poly(c, strip([130, -74], [130, 74], 6), STEEL, 'metal', 12, 1.2);
  for (const y0 of TROUGH_YS) poly(c, strip([TROUGH_X1, y0], [130, y0], 5), STEEL, 'metal', 11, 1);
  for (const s of [-1, 1]) {
    const tank = core(c, ngon(170, s * 42, 28, 8, Math.PI / 8), NUTRIENT, 20, Math.PI / 2);
    poly(c, ngon(170, s * 42, 12, 8, Math.PI / 8), SLAB_DARK, 'metal', 3, 2);
    wornStripe(c, tank, 0, 170, 8, 40 + s);
    strut(c, [130, s * 42], [142, s * 42], 7, 12);
  }
  poly(c, chamferBox(156, -10, 28, 20, 4), SLAB_LIGHT, 'metal', 14, 1.5);
  scaffold(c, -200, -64, 58, 28, 14);
  stencil(c, '34', 138, -96, 16);
  if (c.livery) c.sigils.push({ x: -171, y: 28, r: 13 });
  lamp(c, -171, 54, 3.5, LAMP_WHITE);
  for (const s of [-1, 1]) {
    lamp(c, -140, s * 88, 3.5, LAMP_AMBER);
    lamp(c, 116, s * 88, 3.5, LAMP_AMBER);
  }
}

// ── Fabricator (480 × 360) ──────────────────────────────────────────────────

/** The gantry bridge's x (parked off the press bed, +x side). */
const BRIDGE_X = 70;
/** The gantry rails' y (either side of the hall). */
const RAIL_Y = 128;

/** The fabricator's work-glow slits (x, y, w, h in px, the drawer's frame):
 *  four clerestory slits at the hall's corners and one at the press mouth.
 *  Baked as dead glass; the live overlay lights them while it works. */
export const FABRICATOR_SLITS: ReadonlyArray<WorkSlit> = [
  [-134, -104, 28, 4], [106, -104, 28, 4], [-134, 100, 28, 4], [106, 100, 28, 4], [-20, 34, 40, 4],
];

/** The starved fabricator's red no-supply mark: on the open hall floor
 *  between the press bed and the -x loading door, clear of the gantry
 *  (x, y, half height, stroke; px). */
export const FABRICATOR_MARK: WorkMark = [-104, 14, 13, 3];

/** A chevron pointing along x (`dir` +1 = +x), centred on (cx, cy): the
 *  kit's y chevron mirrored across the diagonal, winding restored. */
function chevronX(cx: number, cy: number, w: number, h: number, t: number, dir: 1 | -1): Pts {
  return chevron(cy, cx, w, h, t, dir).map(([x, y]): Pt => [y, x]).reverse();
}

/** A loading door on the hall's `e` end (+1 = +x): a roller-door housing
 *  with ribbed slats, a hazard sill outside, chevrons on the apron and a
 *  work lamp either side. */
function loadingDoor(c: StyleCtx, e: 1 | -1): void {
  const x0 = e > 0 ? 150 : -174;
  core(c, chamferBox(x0, -64, 24, 128, 6), SLAB_DARK, 18, 0);
  for (let y = -56; y <= 56; y += 8) poly(c, strip([x0 + 3, y], [x0 + 21, y], 1.6), STEEL, 'metal', 19, 0.5);
  poly(c, chamferBox(e > 0 ? 174 : -180, -64, 6, 128, 1.5), HAZARD, 'hazard', 4, 0.5);
  for (const x of [196, 216]) poly(c, chevronX(e * x, 0, 50, 16, 5, e), HAZARD, 'hazard', 1, 0.6);
  for (const s of [-1, 1]) lamp(c, e * 186, s * 74, 3.5, LAMP_WHITE);
}

/** Fabricator: a long gantry press hall. A chamfered hall slab with a heavy
 *  press bed and octagonal ram head in the middle, a gantry bridge (the
 *  tool-head rail) across it on two edge rails with a crane-yellow tool
 *  carriage, roller loading doors with hazard aprons at both ends, a
 *  pipe-rack truss and a walkway outside the rails, clerestory work-glow
 *  slits (baked dark, lit by the live overlay while it works, `status`). */
function fabricator(c: StyleCtx): void {
  deck(c);
  grime(c, -220, -160, 440, 320, 14, 8);
  truss(c, [-180, -158], [180, -158], 22, STEEL, 12);
  walkway(c, [-180, 158], [180, 158], 14);
  // Gantry rails along both long walls, hazard end stops.
  for (const s of [-1, 1]) {
    poly(c, strip([-200, s * RAIL_Y], [200, s * RAIL_Y], 10), STEEL, 'metal', 6, 1.5);
    rivets(c, [-194, s * RAIL_Y], [194, s * RAIL_Y], 22, 2);
    for (const e of [-1, 1]) poly(c, chamferBox(e * 200 - 7, s * RAIL_Y - 10, 14, 20, 3), HAZARD, 'hazard', 7, 1.5);
  }
  // The hall.
  const hall = core(c, chamferBox(-150, -112, 300, 224, 18), SLAB, 22, Math.PI / 2);
  wornStripe(c, hall, Math.PI / 2, -88, 10, 52);
  weld(c, [-140, -20], [-70, -20]);
  weld(c, [-140, 40], [-70, 40]);
  for (const e of [-1, 1] as const) loadingDoor(c, e);
  // Press bed: four frame posts and the ram head.
  core(c, chamferBox(-62, -52, 124, 104, 10), SLAB_LIGHT, 12, 0);
  rivets(c, [-50, -44], [50, -44], 12);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) poly(c, chamferBox(sx * 54 - 6, sy * 44 - 6, 12, 12, 3), STEEL, 'metal', 18, 1);
  core(c, ngon(0, -4, 28, 8, Math.PI / 8), SLAB_DARK, 16, Math.PI / 2);
  poly(c, ngon(0, -4, 12, 6), SLAB_LIGHT, 'metal', 4, 1.5);
  bakeSlits(c, FABRICATOR_SLITS);
  // Gantry bridge (the tool-head rail) on its end trucks, tool carriage on it.
  truss(c, [BRIDGE_X, -RAIL_Y], [BRIDGE_X, RAIL_Y], 26, STEEL, 30);
  for (const s of [-1, 1]) poly(c, chamferBox(BRIDGE_X - 16, s * RAIL_Y - 9, 32, 18, 4), CRANE, 'metal', 32, 1.5);
  poly(c, chamferBox(BRIDGE_X - 18, -46, 36, 32, 5), CRANE, 'metal', 36, 1.5);
  poly(c, ngon(BRIDGE_X, -30, 7, 6), SLAB_DARK, 'metal', 4, 1);
  scaffold(c, 96, 60, 48, 30, 12);
  stencil(c, '47', -122, 60, 20);
  if (c.livery) c.sigils.push({ x: -104, y: -50, r: 16 });
  lamp(c, 0, -158, 4, LAMP_WHITE);
  for (const s of [-1, 1]) for (const e of [-1, 1]) lamp(c, e * 200, s * 146, 3.5, LAMP_AMBER);
}

// ── Tables ─────────────────────────────────────────────────────────────────

/** Live body state: lit only while working, red mark when starved. */
export const status: BodyStatusHookTable = {
  hydroponics: workGlowStatus(HYDROPONICS_SLITS, HYDROPONICS_MARK),
  fabricator: workGlowStatus(FABRICATOR_SLITS, FABRICATOR_MARK),
};

/** Style C drawers for these kinds. */
export const kinds: StyleDrawerTable = {
  hydroponics,
  fabricator,
};
