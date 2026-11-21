/**
 * Style C light production: the munitions works and the reclaimer
 * (docs/plans/structure-restyle-stage4.md §6). Both bake their work-glow glass
 * dark (`bakeSlits`) and light it on the live overlay only while they work, the
 * red no-supply mark when starved (`workGlowStatus`,
 * structureStyleC.lightProduction.work.ts). `kinds` and `status` are spread
 * into the family's tables (structureStyleC.lightProduction.ts).
 */
import {
  CONTAINERS, CRANE, HAZARD, LAMP_AMBER, LAMP_WHITE, RIVET, RUST, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, STEEL,
  chamferBox, chevron, core, deck, grime, lamp, mixColor, ngon, poly, rivets, rng, scaffold, stencil, strip,
  strut, truss, weld, wornStripe, type Pt, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { BodyStatusHookTable } from './structureSocketNubs.js';
import { bakeSlits, workGlowStatus, type WorkMark, type WorkSlit } from './structureStyleC.lightProduction.work.js';

// ── Munitions works (400×300 chamfer) ──────────────────────────────────────

/** The three filling-cell centres (x, px). */
const MUNI_CELLS = [-120, 0, 120] as const;

/** Munitions work-glow slits (x, y, w, h; px): a pair on each cell's filling
 *  press, upper and lower. Baked dead, lit by `status` while it works. */
export const MUNITIONS_SLITS: ReadonlyArray<WorkSlit> = MUNI_CELLS.flatMap((x): WorkSlit[] => [
  [x - 16, -50, 32, 4], [x - 16, 30, 32, 4],
]);

/** The starved munitions works' red mark: on the open face of the middle
 *  press, between its two slits, clear of the trusses (x, y, half height, stroke). */
export const MUNITIONS_MARK: WorkMark = [0, -8, 13, 3];

/** Brass shell casing and its dark nose. */
const BRASS = 0x7d6436;
const SHELL_TIP = 0x2c2620;

/** Munitions works: three filling cells side by side in sunken pits, split
 *  by thick revetment blast walls with hazard-capped tops; a shell conveyor
 *  runs the length of the front carrying brass casings out past chevrons; a
 *  pipe-rack truss along the back. Work glow on each cell's press. */
function munitions_works(c: StyleCtx): void {
  deck(c);
  grime(c, -190, -140, 380, 280, 14, 11);
  truss(c, [-158, -132], [158, -132], 16, STEEL, 12);
  for (const x of [-100, 0, 100]) strut(c, [x, -124], [x, -112], 6, 14);
  // Cells: a sunken pit, a filling press, a blast door at the back (hazard).
  for (let i = 0; i < MUNI_CELLS.length; i++) {
    const cx = MUNI_CELLS[i]!;
    poly(c, chamferBox(cx - 48, -110, 96, 190, 6), SLAB_DARK, 'metal', 2, 1.5, { seams: 12, seamAngle: 0 });
    grime(c, cx - 46, -104, 92, 180, 4, 20 + i);
    poly(c, chamferBox(cx - 40, -108, 80, 12, 3), HAZARD, 'hazard', 8, 1);
    const press = core(c, chamferBox(cx - 34, -64, 68, 110, 10), SLAB, 22, Math.PI / 2);
    wornStripe(c, press, Math.PI / 2, -34 + 2, 6, 30 + i);
    weld(c, [cx - 26, -34], [cx + 26, -34]);
    weld(c, [cx - 26, 14], [cx + 26, 14]);
    rivets(c, [cx - 28, 40], [cx + 28, 40], 9, 1.8);
    // Feed hopper on the press and a hose down to the belt.
    poly(c, ngon(cx + 22, -80, 8, 6), SLAB_LIGHT, 'metal', 14, 1.5);
    poly(c, ngon(cx + 22, -80, 4, 6), SOOT, 'metal', 15, 0.6);
    poly(c, strip([cx, 46], [cx, 92], 8), STEEL, 'metal', 10, 1);
  }
  bakeSlits(c, MUNITIONS_SLITS);
  // Revetments: a wide footing and a tall blast wall between and beside the bays.
  for (const x of [-180, -60, 60, 180]) {
    poly(c, chamferBox(x - 15, -116, 30, 204, 8), mixColor(SLAB, RUST, 0.15), 'metal', 12, 4, { seams: 18, seamAngle: 0 });
    core(c, chamferBox(x - 9, -112, 18, 196, 5), SLAB_LIGHT, 38, 0);
    poly(c, chamferBox(x - 9, -112, 18, 14, 3), HAZARD, 'hazard', 40, 0.8);
    rivets(c, [x, -90], [x, 76], 14, 1.8);
  }
  // Shell conveyor along the front: rails, belt, rollers, casings, chevrons.
  const y0 = 96, y1 = 124;
  poly(c, chamferBox(-176, y0, 352, y1 - y0, 4), SLAB_DARK, 'metal', 6, 1.2, { seams: 6, seamAngle: Math.PI / 2 });
  for (const y of [y0 + 1, y1 - 1]) poly(c, strip([-176, y], [176, y], 3), STEEL, 'metal', 9, 0.6);
  rivets(c, [-170, y0 + 5], [170, y0 + 5], 10, 1.4);
  rivets(c, [-170, y1 - 5], [170, y1 - 5], 10, 1.4);
  for (let x = -150; x <= 150; x += 22) {
    poly(c, chamferBox(x - 4, y0 + 7, 8, 12, 2), BRASS, 'paint', 10, 0.8);
    poly(c, chamferBox(x - 3, y0 + 4, 6, 4, 1.5), SHELL_TIP, 'metal', 11, 0.5);
  }
  for (const s of [-1, 1]) {
    poly(c, chevron(s * 166, 110, 14, 18, 5, 1), HAZARD, 'hazard', 9, 0.6);
    poly(c, chamferBox(s * 186 - 6, 98, 12, 24, 3), CRANE, 'paint', 14, 1);
  }
  stencil(c, '3', 104, 56, 16);
  if (c.livery) c.sigils.push({ x: -120, y: -8, r: 14 });
  lamp(c, 0, 132, 3.5, LAMP_WHITE);
  for (const x of [-180, 180]) lamp(c, x, -122, 3.5, LAMP_AMBER);
  for (const x of MUNI_CELLS) lamp(c, x, -100, 2.5, LAMP_AMBER);
}

// ── Reclaimer (240×200 cluster) ─────────────────────────────────────────────

/** Reclaimer work-glow slits: one up the hopper's left wall, one on the drive
 *  housing, two on the sorter tower. */
export const RECLAIMER_SLITS: ReadonlyArray<WorkSlit> = [
  [-89, -52, 4, 30], [84, -78, 4, 30], [54, -16, 36, 4], [54, 26, 36, 4],
];

/** The starved reclaimer's red mark: the sorter tower's open face, between
 *  its two slits, clear of the trusses (x, y, half height, stroke). */
export const RECLAIMER_MARK: WorkMark = [72, 6, 11, 3];

/** A scatter of scrap plates over the box (x, y, w, h), seeded per structure. */
function scrapHeap(c: StyleCtx, x: number, y: number, w: number, h: number, n: number, salt: number): void {
  const r = rng(c.seed * 6151 + salt);
  const cols = [RUST, STEEL, SLAB_LIGHT, ...CONTAINERS];
  for (let k = 0; k < n; k++) {
    const cx = x + r() * w, cy = y + r() * h, a = r() * Math.PI, l = 5 + r() * 12, t = 3 + r() * 6;
    const ux = Math.cos(a), uy = Math.sin(a);
    const p: Pt[] = [
      [cx - ux * l - uy * t, cy - uy * l + ux * t], [cx + ux * l - uy * t, cy + uy * l + ux * t],
      [cx + ux * l * 0.7 + uy * t, cy + uy * l * 0.7 - ux * t], [cx - ux * l + uy * t * 0.6, cy - uy * l - ux * t * 0.6],
    ];
    poly(c, p, cols[Math.floor(r() * cols.length)]!, 'metal', 2 + r() * 5, 0.8);
  }
}

/** Reclaimer: a hazard-lipped shredder hopper whose dark throat holds two
 *  toothed crusher rollers, a drive housing beside it, a sorter tower on the
 *  right, three chutes dropping into scrap bins along the front, and scrap
 *  heaped on the deck. Work glow on the hopper, drive and sorter. */
function reclaimer(c: StyleCtx): void {
  deck(c);
  grime(c, -112, -92, 224, 184, 16, 13);
  scrapHeap(c, -108, 22, 18, 48, 12, 1);
  scrapHeap(c, 94, 40, 10, 22, 4, 2);
  truss(c, [108, -52], [108, 54], 12, STEEL, 10);
  // Hopper: a heavy rim, the dark throat, hazard lip, two crusher rollers.
  const rim = core(c, chamferBox(-94, -86, 128, 112, 20), SLAB_LIGHT, 28, 0);
  wornStripe(c, rim, 0, -86 + 4, 6, 70);
  poly(c, chamferBox(-80, -72, 100, 84, 10), SOOT, 'metal', 2, 2.5);
  poly(c, chamferBox(-80, 12, 100, 8, 2), HAZARD, 'hazard', 30, 0.8);
  poly(c, chamferBox(-80, -86, 100, 7, 2), HAZARD, 'hazard', 30, 0.8);
  for (const ry of [-48, -18]) {
    poly(c, strip([-72, ry], [12, ry], 20), STEEL, 'metal', 6, 2.5, { seams: 6, seamAngle: 0 });
    for (let x = -66; x <= 6; x += 8) poly(c, chamferBox(x - 2, ry - 11, 4, 22, 1.2), SLAB_LIGHT, 'metal', 8, 0.5);
    for (const ex of [-74, 14]) poly(c, ngon(ex, ry, 7, 8, Math.PI / 8), mixColor(STEEL, RIVET, 0.4), 'metal', 9, 1);
  }
  weld(c, [-80, -33], [20, -33]);
  // Drive housing (top right) shafted into the rollers.
  const drive = core(c, chamferBox(42, -84, 50, 42, 8), SLAB, 22, Math.PI / 2);
  wornStripe(c, drive, Math.PI / 2, -78, 5, 71);
  for (const ry of [-48, -18]) strut(c, [34, ry], [44, -56], 5, 18);
  // Sorter tower (right): slab, drum, scaffold down its side.
  const tower = core(c, chamferBox(46, -30, 52, 74, 8), SLAB_LIGHT, 32, 0);
  wornStripe(c, tower, 0, 98 - 4, 5, 72);
  poly(c, ngon(72, -28, 9, 8, Math.PI / 8), SLAB_DARK, 'metal', 34, 1.5);
  scaffold(c, 36, -26, 10, 64, 12, 10);
  // Sorting chutes from the hopper and the tower into bins on the front.
  const bins: ReadonlyArray<[Pt, Pt, number]> = [
    [[-62, 26], [-72, 62], 0], [[-26, 26], [-26, 62], 1], [[10, 26], [22, 62], 2], [[72, 44], [74, 62], 3],
  ];
  for (const [a, b, i] of bins) {
    poly(c, strip(a, b, 14), STEEL, 'metal', 16, 1.2);
    poly(c, strip(a, b, 6), SOOT, 'metal', 17, 0.5);
    const bin = chamferBox(b[0] - 15, 62, 30, 26, 4);
    poly(c, bin, CONTAINERS[i]!, 'metal', 10, 1.5, { seams: 5, seamAngle: 0 });
    poly(c, chamferBox(b[0] - 11, 66, 22, 18, 3), SOOT, 'metal', 11, 0.8);
    scrapHeap(c, b[0] - 10, 68, 20, 14, 3, 10 + i);
  }
  bakeSlits(c, RECLAIMER_SLITS);
  stencil(c, '14', -112, -30, 14);
  if (c.livery) c.sigils.push({ x: 62, y: -63, r: 10 });
  lamp(c, -14, -92, 3.5, LAMP_WHITE);
  for (const [x, y] of [[108, -60], [-96, 76]] as const) lamp(c, x, y, 3, LAMP_AMBER);
}

// ── Tables ─────────────────────────────────────────────────────────────────

/** Live work glow per kind (`workGlowStatus`, built once at load). */
export const status: BodyStatusHookTable = {
  munitions_works: workGlowStatus(MUNITIONS_SLITS, MUNITIONS_MARK),
  reclaimer: workGlowStatus(RECLAIMER_SLITS, RECLAIMER_MARK),
};

/** Style C drawers for the two kinds. */
export const kinds: StyleDrawerTable = {
  munitions_works,
  reclaimer,
};
