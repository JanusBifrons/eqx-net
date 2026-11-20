/**
 * Style C family "power" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Power + solar: solar, battery, battery bank, reactor.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  LAMP_AMBER, LAMP_WHITE, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, chamferBox, core, deck, frame, glow, grime,
  lamp, ngon, poly, rivets, scaffold, scalePts, stencil, stripe, strut, walkway, wornStripe, type StyleCtx,
  type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';
import type { BodyStatusHook, BodyStatusHookTable } from './structureSocketNubs.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import type { GraphicsContext } from 'pixi.js';
import { getStructureKind, type StructureKindId } from '../../../shared-types/structureKinds.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'f1c';

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

// ── Battery + battery bank: cells that light with the charge (F1 step C) ────

/** A power store's cell grid, sized from its footprint (W × H): tall cells
 *  about 34 wide, at most 8 across, in a padded block at the centre. */
export interface CellGrid { cols: number; rows: number; x0: number; y0: number; cw: number; ch: number; gap: number }

/** The cell grid of a W × H store, into `out` (alloc-free). Shared by the
 *  baked art (dark cell slots) and the live overlay (lit cells), so they
 *  always line up. */
export function cellGrid(W: number, H: number, out: CellGrid): CellGrid {
  const m = Math.min(W, H);
  const pad = Math.max(30, m * 0.16);
  const gap = Math.max(4, m * 0.022);
  const iw = W - 2 * pad, ih = H - 2 * pad;
  const pitch = Math.max(34, iw / 8);
  out.cols = Math.max(2, Math.round(iw / pitch));
  out.rows = Math.max(2, Math.round(ih / (pitch * 1.5)));
  out.cw = (iw - (out.cols - 1) * gap) / out.cols;
  out.ch = (ih - (out.rows - 1) * gap) / out.rows;
  out.x0 = -iw / 2;
  out.y0 = -ih / 2;
  out.gap = gap;
  return out;
}

const _grid: CellGrid = { cols: 0, rows: 0, x0: 0, y0: 0, cw: 0, ch: 0, gap: 0 };

/** Battery / battery bank: a cell block on a slab inside a truss frame. The
 *  cells are baked dark; the live overlay (`status` below) lights them with
 *  the charge, so a charge change never re-bakes this art. */
function powerStore(c: StyleCtx): void {
  const { W, H } = c;
  const g = cellGrid(W, H, _grid);
  const m = Math.min(W, H), pad = (W - (g.cols * g.cw + (g.cols - 1) * g.gap)) / 2;
  const out = deck(c);
  grime(c, -W / 2, -H / 2, W, H, Math.round(m / 40), 5);
  const bw = g.cols * g.cw + (g.cols - 1) * g.gap, bh = g.rows * g.ch + (g.rows - 1) * g.gap;
  core(c, chamferBox(g.x0 - g.gap * 2, g.y0 - g.gap * 2, bw + g.gap * 4, bh + g.gap * 4, g.gap * 2), SLAB, 18, 0);
  for (let r = 0; r < g.rows; r++) {
    for (let k = 0; k < g.cols; k++) {
      const x = g.x0 + k * (g.cw + g.gap), y = g.y0 + r * (g.ch + g.gap);
      poly(c, chamferBox(x, y, g.cw, g.ch, Math.min(g.cw, g.ch) * 0.15), SOOT, 'metal', -3, 1.5);
      poly(c, chamferBox(x + g.cw * 0.3, y - g.gap * 0.6, g.cw * 0.4, g.gap * 0.8, 1), SLAB_LIGHT, 'metal', 2, 0.6); // terminal
    }
  }
  // Margins (sockets sit on the edge, so nothing raised there): a worn
  // livery stripe across the top, rivets under the block, a status lamp,
  // a green charge-controller glass and a hull number.
  wornStripe(c, scalePts(out, 0.86), 0, -H / 2 + pad * 0.42, pad * 0.3, 21);
  rivets(c, [g.x0, g.y0 + bh + g.gap * 4], [g.x0 + bw, g.y0 + bh + g.gap * 4], 14);
  glow(c, chamferBox(bw / 2 - pad * 0.5, bh / 2 + pad * 0.32, pad * 0.5, pad * 0.22, 1.5), 0x7fe0a4, 0.85);
  lamp(c, -bw / 2 + 4, -bh / 2 - pad * 0.45, 3.5, LAMP_AMBER);
  stencil(c, W < 300 ? '1' : '10', -bw / 2, bh / 2 + pad * 0.3, Math.min(16, pad * 0.36));
  if (c.livery) c.sigils.push({ x: bw / 2 - pad * 0.2, y: -bh / 2 - pad * 0.45, r: Math.min(m * 0.05, pad * 0.25) });
}

/** Lit cell colours: the charge amber (the panel CHRG colour), a hot core. */
const CELL_LIT = 0xffb24a;
const CELL_HOT = 0xffe2a8;
const _fill = { color: 0, alpha: 0 };

/** How many of a store's cells are lit: its charge in whole cells. */
function storeCode(kind: StructureKindId, st: StructureRenderState | undefined): number {
  if (st === undefined || !st.built || st.storedPowerMax === undefined || st.storedPowerMax <= 0) return 0;
  const fp = getStructureKind(kind).footprint;
  const g = cellGrid(fp.w, fp.h, _grid);
  const n = g.cols * g.rows;
  const f = Math.min(1, Math.max(0, (st.storedPower ?? 0) / st.storedPowerMax));
  return Math.min(n, Math.round(f * n));
}

/** Light the first `code` cells, bottom row first, left to right. */
function drawStoreCells(g: GraphicsContext, code: number, kind: StructureKindId): void {
  const fp = getStructureKind(kind).footprint;
  const cg = cellGrid(fp.w, fp.h, _grid);
  let lit = 0;
  for (let r = cg.rows - 1; r >= 0 && lit < code; r--) {
    for (let k = 0; k < cg.cols && lit < code; k++, lit++) {
      const x = cg.x0 + k * (cg.cw + cg.gap), y = cg.y0 + r * (cg.ch + cg.gap);
      const i = Math.min(cg.cw, cg.ch) * 0.16;
      g.rect(x + i * 0.5, y + i * 0.5, cg.cw - i, cg.ch - i);
      _fill.color = CELL_LIT; _fill.alpha = 0.85; g.fill(_fill);
      g.rect(x + cg.cw * 0.3, y + i * 1.5, cg.cw * 0.4, cg.ch - i * 3);
      _fill.color = CELL_HOT; _fill.alpha = 0.7; g.fill(_fill);
    }
  }
}

const powerStoreStatus: BodyStatusHook = { code: storeCode, draw: drawStoreCells };

// ── Reactor: dims when dry (F1 step C) ──────────────────────────────────────

/** 1 = a built reactor with no fuel, else 0 (fuelled art is the bake). */
function reactorCode(_kind: StructureKindId, st: StructureRenderState | undefined): number {
  return st !== undefined && st.built && st.noFuel === true ? 1 : 0;
}

const _stroke = { color: 0, alpha: 0, width: 0 };

/** Dry reactor: the core pit goes dark (covers the baked hot core and its
 *  lamp) and a small red no-fuel mark (a fuel drop, slashed) sits on the
 *  containment keep above it. */
function drawReactorDry(g: GraphicsContext, code: number, kind: StructureKindId): void {
  if (code !== 1) return;
  const k = getStructureKind(kind).footprint.w / 400; // drawn for the 400 reactor; follows a resize
  // Dark core: an octagon over the pit.
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    if (i === 0) g.moveTo(Math.cos(a) * 42 * k, Math.sin(a) * 42 * k);
    else g.lineTo(Math.cos(a) * 42 * k, Math.sin(a) * 42 * k);
  }
  g.closePath();
  _fill.color = 0x0b0a09; _fill.alpha = 0.94; g.fill(_fill);
  g.circle(0, 0, 9 * k); _fill.color = 0x2a1a12; _fill.alpha = 1; g.fill(_fill);
  // No-fuel mark: a drop outline with a slash, above the core.
  const cx = 0, cy = -82 * k, h = 13 * k;
  g.moveTo(cx, cy - h);
  g.bezierCurveTo(cx + h * 0.9, cy - h * 0.05, cx + h * 0.75, cy + h, cx, cy + h);
  g.bezierCurveTo(cx - h * 0.75, cy + h, cx - h * 0.9, cy - h * 0.05, cx, cy - h);
  g.closePath();
  _fill.color = 0x140c0a; _fill.alpha = 0.9; g.fill(_fill);
  _stroke.color = 0xff4444; _stroke.alpha = 0.95; _stroke.width = 2.4 * k; g.stroke(_stroke);
  g.moveTo(cx - h, cy - h).lineTo(cx + h, cy + h);
  g.stroke(_stroke);
}

const reactorStatus: BodyStatusHook = { code: reactorCode, draw: drawReactorDry };

/** This family's live body state (`BodyStatusHook`, drawn on the socket-nub
 *  overlay, structureSocketNubs.ts): cells lit by charge, the reactor dry. */
export const status: BodyStatusHookTable = {
  battery: powerStoreStatus,
  battery_bank: powerStoreStatus,
  reactor: reactorStatus,
};

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  battery: powerStore,
  battery_bank: powerStore,
  reactor: powerStation,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
