/**
 * Style C family "power" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Power + solar: solar, battery, battery bank, reactor.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import { GraphicsContext } from 'pixi.js';
import {
  SOLAR_PANEL_HALF_DEEP, SOLAR_PANEL_HALF_LONG, SOLAR_PANEL_XS, SOLAR_PANEL_YS, reactorFanLayout,
} from '../../../core/articulation/rigs/power.js';
import {
  LAMP_AMBER, LAMP_WHITE, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, chamferBox, core, deck, frame, glow, grime,
  lamp, ngon, poly, rivets, scaffold, scalePts, stencil, stripe, strut, walkway, wornStripe, type StyleCtx,
  type StyleDrawerTable, STEEL, RIVET, truss, weld,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';
import type { BodyStatusHook, BodyStatusHookTable } from './structureSocketNubs.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { getStructureKind, type StructureKindId } from '../../../shared-types/structureKinds.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'f1cb';

/** Power station (`reactor`, drawn for 600 × 600 and scaled by the short
 *  side, §9 Family 1): an octagonal containment keep with a deep pit and a
 *  hard-lit core, inside a square truss frame; a cooling fan in a round
 *  shroud on each frame corner (the shroud is baked here, the blades are the
 *  rig's spinning parts, `reactor-fans` / `reactorFanContext`), strutted to
 *  the keep; walkways along two edges, one side scaffolded. Dry, the status
 *  overlay darkens the core and the fans stop (`reactorStatus`, `rigs`). */
function powerStation(c: StyleCtx): void {
  const { W, H } = c;
  const k = Math.min(W, H) / 600;
  const F = reactorFanLayout(W, H);
  deck(c);
  grime(c, -W / 2 + 30 * k, -H / 2 + 30 * k, W - 60 * k, H - 60 * k, 14, 3);
  for (const s of [-1, 1]) walkway(c, [-110 * k, s * (H / 2 - 22 * k)], [110 * k, s * (H / 2 - 22 * k)], 14 * k);
  frame(c, -F.at, -F.at, 2 * F.at, 2 * F.at, 40 * k, 10);
  scaffold(c, F.at - 34 * k, -64 * k, 60 * k, 128 * k, 21 * k, 12);
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const cx = sx * F.at, cy = sy * F.at, d = Math.SQRT1_2;
    strut(c, [sx * 112 * k, sy * 112 * k], [cx - sx * (F.shroud + 8 * k) * d, cy - sy * (F.shroud + 8 * k) * d], 14 * k, 14);
    const collar = core(c, ngon(cx, cy, F.shroud + 14 * k, 12, Math.PI / 12), SLAB_LIGHT, 24, 0);
    wornStripe(c, collar, Math.PI / 2, cy + sy * (F.shroud + 6 * k), 8 * k, 30 + sx + 3 * sy);
    poly(c, ngon(cx, cy, F.shroud, 24), SOOT, 'metal', -8, 3);
    poly(c, ngon(cx, cy, F.shroud * 0.42, 12), SLAB_DARK, 'metal', -6, 1.5); // the motor boss under the hub
    rivets(c, [cx - sx * 10 * k, cy + sy * (F.shroud + 8 * k)], [cx + sx * 34 * k, cy + sy * (F.shroud + 2 * k)], 11 * k);
    lamp(c, cx + sx * (F.shroud + 6 * k) * d, cy - sy * (F.shroud + 6 * k) * d, 4 * k, LAMP_AMBER);
  }
  const keep = core(c, ngon(0, 0, 150 * k, 8, Math.PI / 8), SLAB, 30, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4, b = a + Math.PI / 4, r = 130 * k;
    rivets(c, [Math.cos(a) * r, Math.sin(a) * r], [Math.cos(b) * r, Math.sin(b) * r], 16 * k);
  }
  wornStripe(c, keep, Math.PI / 2, 112 * k, 12 * k, 41);
  poly(c, ngon(0, 0, 98 * k, 8, Math.PI / 8), SLAB_DARK, 'metal', -6, 5);
  poly(c, ngon(0, 0, 60 * k, 8, Math.PI / 8), SOOT, 'metal', -2, 2);
  glow(c, ngon(0, 0, 34 * k, 8, Math.PI / 8), c.live ? 0xffc070 : 0x3a2418, 0.9);
  c.lit(0, 0, 11 * k, c.live ? LAMP_WHITE : 0x3a2418);
  stencil(c, '07', -26 * k, 158 * k, 30 * k);
  if (c.livery) c.sigils.push({ x: 0, y: -F.at, r: 20 * k });
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

/** Battery: a cell block on a slab inside a truss frame. The
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

// ── Battery bank: four cell modules on a busbar cross (F1, drawn for 600) ──

/** The bank's module layout for a W × H footprint: four square-ish modules
 *  (2 × 2) around a central busbar cross. `mx`/`my` are the module centres
 *  (order: bottom-left, bottom-right, top-left, top-right, Pixi frame: +y is
 *  down), `mw`/`mh` their size, `bus` the cross's width. */
export interface BankLayout { mx: number[]; my: number[]; mw: number; mh: number; bus: number; pad: number }

export function bankLayout(W: number, H: number): BankLayout {
  const m = Math.min(W, H);
  const pad = m * 0.08, bus = m * 0.14;
  const mw = (W - 2 * pad - bus) / 2, mh = (H - 2 * pad - bus) / 2;
  const ox = (bus + mw) / 2, oy = (bus + mh) / 2;
  return { mx: [-ox, ox, -ox, ox], my: [oy, oy, -oy, -oy], mw, mh, bus, pad };
}

const BANK_MODULES = 4;

/** How many cells a power store has (battery: one grid; bank: four). */
export function storeCellCount(kind: StructureKindId): number {
  const fp = getStructureKind(kind).footprint;
  if (kind !== 'battery_bank') {
    const g = cellGrid(fp.w, fp.h, _grid);
    return g.cols * g.rows;
  }
  const L = bankLayout(fp.w, fp.h);
  const g = cellGrid(L.mw, L.mh, _grid);
  return BANK_MODULES * g.cols * g.rows;
}

/** Battery bank (`battery_bank`, 600 × 600): four armoured cell modules
 *  (each a smaller battery block: dark cell slots, terminals, a vent grille
 *  on its outer side, a lamp), joined by a riveted busbar cross to a central
 *  junction with a charge-controller glass. The cells are baked dark; the
 *  live overlay lights them, all four modules rising together. */
function batteryBank(c: StyleCtx): void {
  const { W, H } = c;
  const L = bankLayout(W, H);
  const m = Math.min(W, H), k = m / 600;
  deck(c);
  grime(c, -W / 2 + L.pad, -H / 2 + L.pad, W - 2 * L.pad, H - 2 * L.pad, 14, 7);
  // Busbar cross: two bars through the centre, riveted, welded at the hub.
  const bw = L.bus * 0.42, reach = W / 2 - L.pad * 0.6, reachY = H / 2 - L.pad * 0.6;
  poly(c, chamferBox(-reach, -bw / 2, 2 * reach, bw, 4 * k), SLAB_DARK, 'metal', 4, 2);
  poly(c, chamferBox(-bw / 2, -reachY, bw, 2 * reachY, 4 * k), SLAB_DARK, 'metal', 4, 2);
  for (const s of [-1, 1]) {
    rivets(c, [s * (L.bus * 0.6), -bw * 0.3], [s * (reach - 10 * k), -bw * 0.3], 18 * k);
    rivets(c, [-bw * 0.3, s * (L.bus * 0.6)], [-bw * 0.3, s * (reachY - 10 * k)], 18 * k);
  }
  for (let i = 0; i < BANK_MODULES; i++) {
    const cx = L.mx[i]!, cy = L.my[i]!, sx = Math.sign(cx), sy = Math.sign(cy);
    const g = cellGrid(L.mw, L.mh, _grid);
    const iw = g.cols * g.cw + (g.cols - 1) * g.gap, ih = g.rows * g.ch + (g.rows - 1) * g.gap;
    const hw = iw / 2 + g.gap * 3, hh = ih / 2 + g.gap * 3;
    // Strap from the module to the busbar.
    strut(c, [cx - sx * hw * 0.4, cy - sy * hh], [cx - sx * hw * 0.4, sy * bw * 0.5], 14 * k, 8);
    strut(c, [cx - sx * hw, cy - sy * hh * 0.4], [sx * bw * 0.5, cy - sy * hh * 0.4], 14 * k, 8);
    const house = core(c, chamferBox(cx - hw, cy - hh, 2 * hw, 2 * hh, g.gap * 2.5), SLAB, 20, 0);
    wornStripe(c, house, 0, cy - sy * (hh - 7 * k), 7 * k, 50 + i);
    for (let r = 0; r < g.rows; r++) {
      for (let q = 0; q < g.cols; q++) {
        const x = cx + g.x0 + q * (g.cw + g.gap), y = cy + g.y0 + r * (g.ch + g.gap);
        poly(c, chamferBox(x, y, g.cw, g.ch, Math.min(g.cw, g.ch) * 0.15), SOOT, 'metal', -3, 1.5);
        poly(c, chamferBox(x + g.cw * 0.3, y - g.gap * 0.6, g.cw * 0.4, g.gap * 0.8, 1), SLAB_LIGHT, 'metal', 2, 0.6);
      }
    }
    // Vent grille on the module's outer side, a lamp on its outer corner.
    const vx = cx + sx * (hw + 12 * k);
    for (let v = -3; v <= 3; v++) poly(c, chamferBox(vx - 7 * k, cy + v * 11 * k - 2.5 * k, 14 * k, 5 * k, 1), SOOT, 'metal', 1, 0.6);
    lamp(c, cx + sx * (hw - 8 * k), cy + sy * (hh - 8 * k), 3.5 * k, i % 2 === 0 ? LAMP_AMBER : LAMP_WHITE);
  }
  // Central junction: an octagonal hub with the charge-controller glass.
  const hub = core(c, ngon(0, 0, L.bus * 0.62, 8, Math.PI / 8), SLAB_LIGHT, 24, 0);
  wornStripe(c, hub, Math.PI / 4, 0, 6 * k, 61);
  poly(c, ngon(0, 0, L.bus * 0.4, 8, Math.PI / 8), SLAB_DARK, 'metal', -3, 2);
  glow(c, ngon(0, 0, L.bus * 0.22, 8, Math.PI / 8), c.live ? 0x7fe0a4 : 0x14301f, 0.85);
  stencil(c, '10', -W / 2 + L.pad * 1.1, -H / 2 + L.pad * 0.35, 18 * k);
  if (c.livery) c.sigils.push({ x: W / 2 - L.pad * 1.6, y: -H / 2 + L.pad * 0.5, r: 16 * k });
}

/** Lit cell colours: the charge amber (the panel CHRG colour), a hot core. */
const CELL_LIT = 0xffb24a;
const CELL_HOT = 0xffe2a8;
const _fill = { color: 0, alpha: 0 };

/** How many of a store's cells are lit: its charge in whole cells. */
function storeCode(kind: StructureKindId, st: StructureRenderState | undefined): number {
  if (st === undefined || !st.built || st.storedPowerMax === undefined || st.storedPowerMax <= 0) return 0;
  const n = storeCellCount(kind);
  const f = Math.min(1, Math.max(0, (st.storedPower ?? 0) / st.storedPowerMax));
  return Math.min(n, Math.round(f * n));
}

/** Light the first `code` cells of a store (battery: one grid; bank: its
 *  four modules). */
function drawStoreCells(g: GraphicsContext, code: number, kind: StructureKindId): void {
  const fp = getStructureKind(kind).footprint;
  if (kind !== 'battery_bank') {
    litCells(g, cellGrid(fp.w, fp.h, _grid), 0, 0, code);
    return;
  }
  // Bank: the lit cells share out across the four modules, so they rise
  // together (the bottom modules take the remainder first).
  const L = bankLayout(fp.w, fp.h);
  const cg = cellGrid(L.mw, L.mh, _grid);
  for (let i = 0; i < BANK_MODULES; i++) {
    const n = Math.floor(code / BANK_MODULES) + (i < code % BANK_MODULES ? 1 : 0);
    litCells(g, cg, L.mx[i]!, L.my[i]!, n);
  }
}

/** Light the first `code` cells of grid `cg` (offset by ox, oy), bottom
 *  row first, left to right. */
function litCells(g: GraphicsContext, cg: CellGrid, ox: number, oy: number, code: number): void {
  let lit = 0;
  for (let r = cg.rows - 1; r >= 0 && lit < code; r--) {
    for (let k = 0; k < cg.cols && lit < code; k++, lit++) {
      const x = ox + cg.x0 + k * (cg.cw + cg.gap), y = oy + cg.y0 + r * (cg.ch + cg.gap);
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

/** A reactor is dry when built with no fuel: its core goes dark (`reactorCode`)
 *  and its fans stop (`reactorFuelled`); one flag, `noFuel`, drives both. */
function reactorDry(st: StructureRenderState | undefined): boolean {
  return st !== undefined && st.built && st.noFuel === true;
}

/** Fans run on a built reactor with fuel (the rig's `running` hook). */
export function reactorFuelled(st: StructureRenderState | undefined): boolean {
  return st !== undefined && st.built && !reactorDry(st);
}

/** 1 = a built reactor with no fuel, else 0 (fuelled art is the bake). */
function reactorCode(_kind: StructureKindId, st: StructureRenderState | undefined): number {
  return reactorDry(st) ? 1 : 0;
}

const _stroke = { color: 0, alpha: 0, width: 0 };

/** Dry reactor: the core pit goes dark (covers the baked hot core and its
 *  lamp) and a small red no-fuel mark (a fuel drop, slashed) sits on the
 *  containment keep's top band, above the pit (layout of `powerStation`,
 *  drawn for 600, scaled by the short side). */
function drawReactorDry(g: GraphicsContext, code: number, kind: StructureKindId): void {
  if (code !== 1) return;
  const fp = getStructureKind(kind).footprint;
  const k = Math.min(fp.w, fp.h) / 600;
  // Dark core: an octagon over the pit (covers the soot ring and the glow).
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    if (i === 0) g.moveTo(Math.cos(a) * 64 * k, Math.sin(a) * 64 * k);
    else g.lineTo(Math.cos(a) * 64 * k, Math.sin(a) * 64 * k);
  }
  g.closePath();
  _fill.color = 0x0b0a09; _fill.alpha = 0.94; g.fill(_fill);
  g.circle(0, 0, 13 * k); _fill.color = 0x2a1a12; _fill.alpha = 1; g.fill(_fill);
  // No-fuel mark: a drop outline with a slash, on the keep above the core.
  const cx = 0, cy = -120 * k, h = 15 * k;
  g.moveTo(cx, cy - h);
  g.bezierCurveTo(cx + h * 0.9, cy - h * 0.05, cx + h * 0.75, cy + h, cx, cy + h);
  g.bezierCurveTo(cx - h * 0.75, cy + h, cx - h * 0.9, cy - h * 0.05, cx, cy - h);
  g.closePath();
  _fill.color = 0x140c0a; _fill.alpha = 0.9; g.fill(_fill);
  _stroke.color = 0xff4444; _stroke.alpha = 0.95; _stroke.width = 3 * k; g.stroke(_stroke);
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

// A cooling fan (the `reactor-fans` rig part's own art, in the part's Pixi
// frame, centred on its hub): five swept gunmetal blades with a bright
// leading lip and a dark edge, over a hub cap with a white index mark, so
// the spin reads at a glance. Drawn once, shared by every fan; posing only
// turns it. Sized from the reactor's catalogue footprint, like the rig's
// anchors (`reactorFanLayout`).
const FAN_BLADE = 0x59626b;
const FAN_LIP = 0xb7c0c8;
const FAN_HUB = 0x2a2f35;
let fanCtx: GraphicsContext | null = null;

/** Point at radius `r`, angle `a` (scratch-free: bake time only). */
function polar(r: number, a: number): [number, number] {
  return [Math.cos(a) * r, Math.sin(a) * r];
}

/** The shared art of every reactor cooling fan (built on first use). */
export function reactorFanContext(): GraphicsContext {
  if (fanCtx !== null) return fanCtx;
  const fp = getStructureKind('reactor').footprint;
  const R = reactorFanLayout(fp.w, fp.h).blade;
  const hub = R * 0.3, n = 5;
  const g = new GraphicsContext();
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n;
    const [x0, y0] = polar(hub * 0.8, a - 0.32), [x1, y1] = polar(R, a - 0.2);
    const [x2, y2] = polar(R, a + 0.3), [x3, y3] = polar(hub * 0.8, a + 0.42);
    const [c1x, c1y] = polar(R * 0.62, a - 0.42), [c2x, c2y] = polar(R * 1.04, a + 0.05), [c3x, c3y] = polar(R * 0.6, a + 0.12);
    g.moveTo(x0, y0).quadraticCurveTo(c1x, c1y, x1, y1).quadraticCurveTo(c2x, c2y, x2, y2).quadraticCurveTo(c3x, c3y, x3, y3).closePath()
      .fill({ color: FAN_BLADE }).stroke({ color: 0x0a0c0e, width: 1.4 });
    g.moveTo(x0, y0).quadraticCurveTo(c1x, c1y, x1, y1).stroke({ color: FAN_LIP, width: 1.8, alpha: 0.85 });
  }
  g.circle(0, 0, hub).fill({ color: FAN_HUB }).stroke({ color: FAN_LIP, width: 1.6 });
  g.circle(0, 0, hub * 0.45).fill({ color: 0x15181b });
  g.rect(hub * 0.15, -hub * 0.12, hub * 0.7, hub * 0.24).fill({ color: 0xe8ecef, alpha: 0.9 });
  fanCtx = g;
  return g;
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  battery: powerStore,
  battery_bank: batteryBank,
  reactor: powerStation,
  solar: solarArray,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {
  'solar-tracker': { partArt: () => solarPanelContext() },
  'reactor-fans': { partArt: () => reactorFanContext(), running: reactorFuelled },
};
