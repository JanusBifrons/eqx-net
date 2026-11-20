/**
 * Style C family "lightProduction" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Light production: smelter, silicon works, hydroponics, fabricator, munitions works, reclaimer,
 * gas collector, research lab, refinery.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  LAMP_AMBER, LAMP_WHITE, SLAB_DARK, SLAB_LIGHT, STEEL, chamferBox, core, deck, glow, grime, lamp, ngon,
  poly, rivets, scaffold, stencil, strut, truss, weld, wornStripe, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';
import type { GraphicsContext } from 'pixi.js';
import type { BodyStatusHook, BodyStatusHookTable } from './structureSocketNubs.js';
import { drawNoSupplyMark } from './structureStyleC.power.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import type { StructureKindId } from '../../../shared-types/structureKinds.js';
import { PROD_STATE } from '../../../shared-types/production.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'r1';

/** The refinery's work-glow slits (x, y, w, h in px, the drawer's frame):
 *  one on each tank bunker, two on the column. Baked as dead glass
 *  (`SLIT_DEAD`); the live overlay (`status`) lights them while it works. */
export const REFINERY_SLITS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-124, -2, 24, 4], [100, -2, 24, 4], [-20, -14, 40, 4], [-20, 58, 40, 4],
];

/** Unlit work-glow glass: a dark, faintly amber pane. */
export const SLIT_DEAD = 0x2a1c12;

/** Where the starved refinery's red no-supply mark sits: low on the column,
 *  below the lower slit (x, y, half height, stroke width; px). */
export const REFINERY_MARK = [0, 96, 13, 3] as const;

/** Refinery: a tall chamfered cracking column on the axis, two octagonal
 *  tank bunkers mirrored either side and strutted in, pipe-rack trusses
 *  above and below, a scaffold up the column, small hard work-glow slits
 *  (baked dark, lit by the live overlay while it works, `status`). */
function refinery(c: StyleCtx): void {
  deck(c);
  grime(c, -170, -130, 340, 260, 12, 6);
  for (const s of [-1, 1]) truss(c, [-150, s * 104], [150, s * 104], 24, STEEL, 12);
  for (const s of [-1, 1]) {
    const tank = core(c, ngon(s * 112, 0, 56, 8, Math.PI / 8), 0x3a3631, 22, Math.PI / 2);
    poly(c, ngon(s * 112, 0, 26, 8, Math.PI / 8), SLAB_DARK, 'metal', 3, 2);
    rivets(c, [s * 112 - 40, -40], [s * 112 + 40, -40], 10);
    wornStripe(c, tank, Math.PI / 2, 30, 8, 50 + s);
    strut(c, [s * 58, 0], [s * 40, 0], 12, 16);
    for (const t of [-1, 1]) strut(c, [s * 112, t * 58], [s * 112, t * 92], 8, 14);
  }
  const col = core(c, chamferBox(-40, -124, 80, 248, 20), SLAB_LIGHT, 40, 0);
  weld(c, [-30, -40], [30, -40]);
  weld(c, [-30, 40], [30, 40]);
  wornStripe(c, col, Math.PI / 2, 84, 12, 60);
  for (const [x, y, w, h] of REFINERY_SLITS) glow(c, chamferBox(x, y, w, h, 1.5), SLIT_DEAD, 0.9);
  scaffold(c, -48, -124, 96, 64, 16, 12);
  stencil(c, '21', -15, 8, 24);
  if (c.livery) c.sigils.push({ x: 0, y: -26, r: 16 });
  lamp(c, 0, -112, 4, LAMP_WHITE);
  for (const s of [-1, 1]) lamp(c, s * 150, -104, 3.5, LAMP_AMBER);
}

// ── Live work glow (BodyStatusHook) ──────────────────────────────────────────

/** Refinery status codes: 0 dark (idle, blocked, unbuilt or unpowered), 1 the
 *  slits lit (producing), 2 dark with a red no-supply mark (an input is
 *  missing). Read from the row's `prodState` (`PROD_STATE`). */
export const REFINERY_DARK = 0;
export const REFINERY_WORKING = 1;
export const REFINERY_STARVED = 2;

function refineryCode(_kind: StructureKindId, st: StructureRenderState | undefined): number {
  if (st === undefined || !st.built || !st.powered) return REFINERY_DARK;
  if (st.prodState === PROD_STATE.running) return REFINERY_WORKING;
  if (st.prodState === PROD_STATE.starved) return REFINERY_STARVED;
  return REFINERY_DARK;
}

const _fill = { color: 0, alpha: 0 };

/** Working: each slit lit amber with a soft halo and a hot white core line.
 *  Starved: the red no-supply mark (the reactor's no-fuel mark). */
function drawRefineryStatus(g: GraphicsContext, code: number): void {
  if (code === REFINERY_WORKING) {
    for (const [x, y, w, h] of REFINERY_SLITS) {
      g.roundRect(x - 3, y - 3, w + 6, h + 6, 3); _fill.color = LAMP_AMBER; _fill.alpha = 0.22; g.fill(_fill);
      g.roundRect(x, y, w, h, 1.5); _fill.color = LAMP_AMBER; _fill.alpha = 0.95; g.fill(_fill);
      g.rect(x + 2, y + h / 2 - 0.6, w - 4, 1.2); _fill.color = LAMP_WHITE; _fill.alpha = 0.85; g.fill(_fill);
    }
  } else if (code === REFINERY_STARVED) {
    const [mx, my, mh, mw] = REFINERY_MARK;
    drawNoSupplyMark(g, mx, my, mh, mw);
  }
}

const refineryStatus: BodyStatusHook = { code: refineryCode, draw: drawRefineryStatus };

/** This family's live body state (`BodyStatusHook`, drawn on the socket-nub
 *  overlay, structureSocketNubs.ts): the refinery lit while it works. */
export const status: BodyStatusHookTable = {
  refinery: refineryStatus,
};

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  refinery,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
