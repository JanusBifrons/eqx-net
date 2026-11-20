/**
 * Style C family "power" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Power + solar: solar, battery, battery bank, reactor.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import { GraphicsContext } from 'pixi.js';
import { SOLAR_PANEL_HALF_DEEP, SOLAR_PANEL_HALF_LONG, SOLAR_PANEL_XS, SOLAR_PANEL_YS } from '../../../core/articulation/rigs/power.js';
import {
  LAMP_AMBER, LAMP_WHITE, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, chamferBox, core, deck, frame, glow, grime,
  lamp, ngon, poly, rivets, scaffold, stencil, stripe, strut, walkway, wornStripe, type StyleCtx,
  type StyleDrawerTable, STEEL, RIVET, truss, weld,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'f1s1';

/** Power station (`reactor`): an octagonal containment keep with a deep pit
 *  and a hard-lit core, inside a square truss frame, four ribbed cooling
 *  blocks on the frame's corners, struts in, walkways, one block scaffolded. */
function powerStation(c: StyleCtx): void {
  deck(c);
  grime(c, -180, -180, 360, 360, 10, 3);
  frame(c, -150, -150, 300, 300, 30, 10);
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const blk = core(c, chamferBox(sx * 140 - 36, sy * 140 - 36, 72, 72, 16), SLAB_LIGHT, 24, 0);
    for (let k = -2; k <= 2; k++) poly(c, stripe(blk, Math.PI / 2, sy * 140 + k * 11, 4), SOOT, 'metal', 2, 0.8);
    wornStripe(c, blk, 0, sx * 140 - sx * 24, 8, 30 + sx + 3 * sy);
    strut(c, [sx * 76, sy * 76], [sx * 112, sy * 112], 10, 14);
    lamp(c, sx * 140 + sx * 26, sy * 140 - sy * 26, 3.5, LAMP_AMBER);
  }
  core(c, ngon(0, 0, 108, 8, Math.PI / 8), SLAB, 30, 0);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    rivets(c, [Math.cos(a) * 92, Math.sin(a) * 92], [Math.cos(a + Math.PI / 4) * 92, Math.sin(a + Math.PI / 4) * 92], 13);
  }
  poly(c, ngon(0, 0, 66, 8, Math.PI / 8), SLAB_DARK, 'metal', -6, 5);
  poly(c, ngon(0, 0, 40, 8, Math.PI / 8), SOOT, 'metal', -2, 2);
  glow(c, ngon(0, 0, 22, 8, Math.PI / 8), c.live ? 0xffc070 : 0x3a2418, 0.9);
  c.lit(0, 0, 8, c.live ? LAMP_WHITE : 0x3a2418);
  for (const s of [-1, 1]) walkway(c, [-110, s * 186], [110, s * 186], 12);
  scaffold(c, 96, 96, 84, 84, 17, 12);
  stencil(c, '07', -18, 112, 22);
  if (c.livery) c.sigils.push({ x: -140, y: -140, r: 18 });
}

/** Solar array (`solar`, drawn for 700 × 300, §9 Family 1): a long soot
 *  deck with a lattice spine down its middle, eight slewing pedestals (4 × 2)
 *  strutted to it, an inverter cabinet at each end with its lamps, walkways
 *  along the long edges. The panels are the rig's aiming parts
 *  (`solar-tracker`, `solarPanelContext`): they turn to face the sun. The
 *  pedestals sit on the rig's anchors (the layout is symmetric in y, so the
 *  Pixi flip changes nothing). */
function solarArray(c: StyleCtx): void {
  deck(c);
  const hw = c.W / 2, hh = c.H / 2;
  grime(c, -hw + 20, -hh + 20, c.W - 40, c.H - 40, 12, 5);
  for (const s of [-1, 1]) walkway(c, [-hw + 40, s * (hh - 16)], [hw - 40, s * (hh - 16)], 12);
  truss(c, [-hw + 46, 0], [hw - 46, 0], 22, STEEL, 10);
  for (const x of SOLAR_PANEL_XS) {
    for (const y of SOLAR_PANEL_YS) {
      const sy = Math.sign(y);
      strut(c, [x, sy * 13], [x, y - sy * 22], 8, 8);
      core(c, ngon(x, y, 24, 8, Math.PI / 8), SLAB_LIGHT, 16, 0);
      poly(c, ngon(x, y, 15, 8, Math.PI / 8), SLAB_DARK, 'metal', -2, 2);
      poly(c, ngon(x, y, 8, 8, Math.PI / 8), SOOT, 'metal', -1, 1);
      weld(c, [x - 20, y + sy * 28], [x + 20, y + sy * 28]);
    }
  }
  for (const s of [-1, 1]) {
    const cx = s * (hw - 34);
    const cab = core(c, chamferBox(cx - 22, -58, 44, 116, 10), SLAB, 22, Math.PI / 2);
    for (let k = -3; k <= 3; k++) poly(c, stripe(cab, Math.PI / 2, k * 13, 3), SOOT, 'metal', 2, 0.6);
    wornStripe(c, cab, 0, cx, 8, 40 + s);
    // The inverter readout: a lit port while the array feeds the grid.
    glow(c, chamferBox(cx - 7, -24, 14, 34, 3), c.live ? 0x7fd4ff : 0x142430, 0.85);
    rivets(c, [cx - 16, 64], [cx + 16, 64], 8);
    lamp(c, cx, -44, 3.5, LAMP_AMBER);
    lamp(c, cx, 44, 3, LAMP_WHITE);
  }
  stencil(c, '04', -hw + 70, -hh + 34, 16);
  if (c.livery) c.sigils.push({ x: hw - 34, y: 0, r: 14 });
}

// A panel (the rig part's own art, in the part's Pixi frame: its face
// normal is +x, its long side along y). Deep-blue cells in a gunmetal frame,
// a bright machined lip on the sun side, a hub over the pedestal, a soft sky
// glint. Drawn once, shared by every panel; posing only turns it.
const PANEL_FRAME = 0x2a2f35;
const PANEL_EDGE = 0x0a0c0e;
const PANEL_CELL = 0x16243a;
const PANEL_CELL_LINE = 0x2c4466;
const PANEL_LIP = 0xa3acb5;
let panelCtx: GraphicsContext | null = null;

/** The shared art of every solar panel (built on first use). */
export function solarPanelContext(): GraphicsContext {
  if (panelCtx !== null) return panelCtx;
  const d = SOLAR_PANEL_HALF_DEEP, l = SOLAR_PANEL_HALF_LONG;
  const g = new GraphicsContext();
  g.roundRect(-d, -l, 2 * d, 2 * l, 3).fill({ color: PANEL_FRAME }).stroke({ color: PANEL_EDGE, width: 2 });
  const cols = 2, rows = 6, m = 4, gap = 2;
  const cw = (2 * d - 2 * m - gap * (cols - 1)) / cols, ch = (2 * l - 2 * m - gap * (rows - 1)) / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = -d + m + i * (cw + gap), y = -l + m + j * (ch + gap);
      g.rect(x, y, cw, ch).fill({ color: PANEL_CELL }).stroke({ color: PANEL_CELL_LINE, width: 0.8 });
      g.moveTo(x + cw / 2, y + 1).lineTo(x + cw / 2, y + ch - 1).stroke({ color: PANEL_CELL_LINE, width: 0.5, alpha: 0.6 });
    }
  }
  g.poly([-d + m, -l * 0.2, d - m, -l * 0.55, d - m, -l * 0.35, -d + m, 0], true).fill({ color: 0x9fc4ff, alpha: 0.1 });
  g.rect(d - 2.5, -l + 2, 2.5, 2 * l - 4).fill({ color: PANEL_LIP });
  g.rect(-d, -l + 2, 2, 2 * l - 4).fill({ color: PANEL_EDGE, alpha: 0.7 });
  g.circle(0, 0, 7).fill({ color: PANEL_FRAME }).stroke({ color: PANEL_LIP, width: 1.4 });
  for (const y of [-l + 2.5, l - 2.5]) for (const x of [-d + 2.5, d - 2.5]) g.circle(x, y, 1.1).fill({ color: RIVET });
  panelCtx = g;
  return g;
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  reactor: powerStation,
  solar: solarArray,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {
  'solar-tracker': { partArt: () => solarPanelContext() },
};
