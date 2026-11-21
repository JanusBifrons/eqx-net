/**
 * Style C family "lightProduction": the smelter and the silicon works
 * (docs/plans/structure-restyle-stage4.md §6). Spread into the family's
 * `kinds` and `status` tables (structureStyleC.lightProduction.ts). Both bake
 * their work-glow glass dark and light it only while they work
 * (structureStyleC.lightProduction.work.ts).
 */
import {
  HAZARD, LAMP_AMBER, LAMP_WHITE, RIVET, RUST, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, STEEL, chamferBox, core,
  deck, grime, lamp, mixColor, ngon, poly, rivets, rng, scaffold, stencil, strip, strut, truss, walkway, weld,
  wornStripe, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { BodyStatusHookTable } from './structureSocketNubs.js';
import { bakeSlits, workGlowStatus, type WorkMark, type WorkSlit } from './structureStyleC.lightProduction.work.js';

// ── Smelter (360 × 260) ────────────────────────────────────────────────────

/** The smelter's work-glow slits (x, y, w, h in px, the drawer's frame): the
 *  melt in each crucible pour channel, the furnace tap hole, and two runs of
 *  the casting bed's runner. Baked dark, lit while it works. */
export const SMELTER_SLITS: ReadonlyArray<WorkSlit> = [
  [-92, -58, 24, 4], [-92, 54, 24, 4], [-16, 30, 32, 4], [118, -32, 4, 22], [118, 18, 4, 22],
];

/** The starved smelter's red no-supply mark: on the furnace's open front face,
 *  between the stacks and the tap slit (x, y, half height, stroke width; px). */
export const SMELTER_MARK: WorkMark = [0, 2, 12, 3];

const CRUCIBLE = 0x3a3631;

/** Smelter: a squat furnace block on the axis with two soot-throated stacks;
 *  two tilting crucibles on the left fed by short pour channels from the
 *  furnace's flank; an ingot casting bed on the right (a runner down its
 *  middle, moulds either side, some holding cast ingots), fed by a trough
 *  from the furnace; a ladle-crane truss across the top, a walkway along the
 *  bottom, a scaffold on the furnace face. */
function smelter(c: StyleCtx): void {
  deck(c);
  grime(c, -172, -122, 344, 244, 12, 9);
  truss(c, [-130, -110], [130, -110], 22, STEEL, 12);
  walkway(c, [-120, 112], [120, 112], 14);
  // Crucibles and their pour channels (left).
  for (const s of [-1, 1]) {
    const y = s * 56;
    poly(c, chamferBox(-102, y - 8, 44, 16, 3), SLAB_DARK, 'metal', 10, 1.5);
    poly(c, chamferBox(-100, y - 5, 40, 10, 2), SOOT, 'metal', -2, 1);
    const pot = core(c, ngon(-128, y, 34, 12, Math.PI / 12), CRUCIBLE, 26, Math.PI / 2);
    wornStripe(c, pot, 0, -152, 7, 70 + s);
    poly(c, ngon(-128, y, 25, 12, Math.PI / 12), SLAB_DARK, 'metal', 3, 2);
    poly(c, ngon(-128, y, 17, 12, Math.PI / 12), SOOT, 'metal', -4, 1.5);
    poly(c, chamferBox(-100, y - 6, 8, 12, 2), RUST, 'metal', 4, 1); // the pour lip
    for (const t of [-1, 1]) poly(c, chamferBox(-134, y + t * 38 - 4, 12, 8, 2), SLAB_LIGHT, 'metal', 28, 1); // trunnions
  }
  // Control booth between the crucibles (the livery slot sits on its roof).
  core(c, chamferBox(-150, -18, 40, 36, 6), SLAB_LIGHT, 16, 0);
  // Furnace block.
  const furnace = core(c, chamferBox(-62, -84, 124, 160, 18), SLAB, 34, 0);
  wornStripe(c, furnace, Math.PI / 2, -78, 8, 80);
  weld(c, [-52, -18], [52, -18]);
  weld(c, [-52, 60], [20, 60]);
  rivets(c, [-54, 70], [54, 70], 12);
  for (const s of [-1, 1]) {
    poly(c, ngon(s * 30, -50, 30, 10, Math.PI / 10), SOOT, 'mark', 0.2, 0.5); // soot fall round the stack
    core(c, ngon(s * 30, -50, 22, 10, Math.PI / 10), SLAB_LIGHT, 52, Math.PI / 2);
    poly(c, ngon(s * 30, -50, 15, 10, Math.PI / 10), SOOT, 'metal', -6, 2);
    poly(c, ngon(s * 30, -50, 7, 10, Math.PI / 10), 0x0a0908, 'metal', -4, 1);
  }
  scaffold(c, 26, 10, 32, 56, 14, 12);
  // Feed trough from the furnace to the casting bed.
  poly(c, chamferBox(58, -7, 64, 14, 3), SLAB_DARK, 'metal', 10, 1.5);
  poly(c, chamferBox(60, -4, 60, 8, 2), SOOT, 'metal', -2, 1);
  // Casting bed (right): the runner, moulds either side, cast ingots.
  const bed = core(c, chamferBox(78, -80, 84, 160, 10), SLAB_DARK, 12, Math.PI / 2);
  wornStripe(c, bed, 0, 156, 5, 90);
  poly(c, chamferBox(114, -72, 12, 144, 3), SOOT, 'metal', -2, 1);
  poly(c, chamferBox(82, -78, 76, 6, 2), HAZARD, 'hazard', 13, 0.5);
  const r = rng(c.seed * 613 + 17);
  for (let row = 0; row < 5; row++) {
    for (const x of [88, 132]) {
      const y = -68 + row * 28;
      poly(c, chamferBox(x, y, 20, 20, 3), SOOT, 'metal', -3, 1.2);
      if (r() < 0.55) poly(c, chamferBox(x + 3, y + 3, 14, 14, 3), mixColor(RUST, SLAB_LIGHT, 0.35), 'metal', 1, 1.5);
    }
  }
  bakeSlits(c, SMELTER_SLITS);
  stencil(c, '34', -52, 38, 18);
  if (c.livery) c.sigils.push({ x: -130, y: 0, r: 15 });
  lamp(c, 0, -110, 4, LAMP_WHITE);
  for (const s of [-1, 1]) lamp(c, s * 150, -100, 3.5, LAMP_AMBER);
}

// ── Silicon works (320 × 320) ──────────────────────────────────────────────

const PULLER_X = [-92, 0, 92] as const;
const PULLER_Y = -80;

/** The silicon works' work-glow slits: a viewport on each crystal puller
 *  (the growth heater) and one over the clean room's central aisle. */
export const SILICON_SLITS: ReadonlyArray<WorkSlit> = [
  ...PULLER_X.map((x): WorkSlit => [x - 11, PULLER_Y + 24, 22, 4]),
  [-14, 30, 28, 4],
];

/** The starved silicon works' red no-supply mark: low on the clean room's
 *  open central aisle, clear of the wafer bays and the vents. */
export const SILICON_MARK: WorkMark = [0, 94, 11, 3];

const WAFER = mixColor(SLAB_LIGHT, 0x5a6a78, 0.4);
const BAY_XS = [-118, -82, -46, 18, 54, 90] as const;

/** Silicon works: a row of three tall crystal-growth pullers across the top
 *  (round chambers on plinths, riveted flanges, domed pull heads with the
 *  seed-shaft cable run up to a rail truss), a spine walkway, and a sealed
 *  clean-room block below holding two rows of wafer bays either side of a
 *  central aisle, air-handler vents along its foot, a hazard-striped airlock
 *  and a scaffold down its flank. */
function siliconWorks(c: StyleCtx): void {
  deck(c);
  grime(c, -150, -150, 300, 300, 12, 11);
  truss(c, [-112, -140], [112, -140], 20, STEEL, 12);
  walkway(c, [-148, -24], [148, -24], 14);
  // Crystal-growth pullers.
  PULLER_X.forEach((x, i) => {
    const y = PULLER_Y;
    strut(c, [x, -40], [x, 8], 8, 10); // service riser down to the clean room
    poly(c, ngon(x, y, 42, 8, Math.PI / 8), SLAB_DARK, 'metal', 6, 2);
    const chamber = core(c, ngon(x, y, 36, 16), SLAB_LIGHT, 30, Math.PI / 2);
    wornStripe(c, chamber, 0, x - 27, 6, 90 + i);
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      poly(c, ngon(x + Math.cos(a) * 30, y + Math.sin(a) * 30, 2.2, 6), RIVET, 'metal', 1, 0.6);
    }
    poly(c, ngon(x, y, 20, 12), SLAB, 'metal', 8, 3, { roof: [3, 6] });
    poly(c, strip([x, y - 7], [x, -128], 3), STEEL, 'metal', 16, 0.8); // pull-cable housing
    poly(c, ngon(x, y, 7, 6), RIVET, 'metal', 14, 1.5);
    strut(c, [x - 14, -122], [x - 14, -130], 6, 14);
  });
  // Clean room.
  scaffold(c, -150, 20, 18, 96, 16, 12);
  const room = core(c, chamferBox(-128, 14, 256, 114, 14), SLAB_LIGHT, 26, 0);
  wornStripe(c, room, Math.PI / 2, 20, 6, 101);
  const r = rng(c.seed * 409 + 23);
  for (const by of [30, 70]) {
    for (const bx of BAY_XS) {
      poly(c, chamferBox(bx, by, 28, 28, 4), SOOT, 'metal', -3, 1.5);
      if (r() < 0.75) poly(c, ngon(bx + 14, by + 14, 10, 12), WAFER, 'metal', 1, 1);
    }
  }
  for (const x of [-116, -100, -84, -68, -52, -36, 26, 42, 58, 74, 90, 106]) {
    poly(c, chamferBox(x, 104, 10, 14, 1), SOOT, 'metal', 1, 0.6);
  }
  rivets(c, [-120, 124], [120, 124], 12);
  weld(c, [-20, 22], [-20, 120]);
  weld(c, [20, 22], [20, 120]);
  poly(c, chamferBox(124, 50, 10, 40, 2), HAZARD, 'hazard', 28, 0.8); // airlock
  bakeSlits(c, SILICON_SLITS);
  stencil(c, '52', -150, -8, 16);
  if (c.livery) c.sigils.push({ x: 0, y: 58, r: 11 });
  lamp(c, 0, -140, 4, LAMP_WHITE);
  for (const s of [-1, 1]) lamp(c, s * 150, -24, 3.5, LAMP_AMBER);
}

/** Live work glow for these kinds (`workGlowStatus`). */
export const status: BodyStatusHookTable = {
  smelter: workGlowStatus(SMELTER_SLITS, SMELTER_MARK),
  silicon_works: workGlowStatus(SILICON_SLITS, SILICON_MARK),
};

/** Style C drawers for these kinds. */
export const kinds: StyleDrawerTable = {
  smelter,
  silicon_works: siliconWorks,
};
