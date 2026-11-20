/**
 * Style C family "storage" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Storage + habitation: storage vault, habitat, tower, cargo bay.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts), `status` (the fill gauges) into `BODY_STATUS_HOOKS`.
 * Kind -> family: structureFamilies.ts.
 */
import {
  CONTAINERS, CRANE, HAZARD, LAMP_AMBER, LAMP_WHITE, RIVET, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, STEEL, chamferBox, core, deck, glow,
  grime, lamp, mixColor, ngon, poly, rivets, rng, scalePts, stencil, stripe, strip, truss, weld, wornStripe, type Pt, type StyleCtx,
  type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';
import type { GraphicsContext } from 'pixi.js';
import type { BodyStatusHook, BodyStatusHookTable } from './structureSocketNubs.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { getStructureKind, type StructureKindId } from '../../../shared-types/structureKinds.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'v3';

/** Cargo hold containers, in fill order (bottom row first, left to right;
 *  +y is down): centres in the 320 x 200 drawing. Each has a fill strip on
 *  its outer long edge, baked dead glass, lit by the live overlay. */
export const BAY_CONTAINERS: readonly (readonly [number, number])[] = [[-64, 36], [64, 36], [-64, -36], [64, -36]];
/** A container's fill strip: half length, half height, inset of its centre
 *  from the container centre towards the outer long edge. */
const BAY_STRIP_HW = 40, BAY_STRIP_HH = 1.6, BAY_STRIP_OFF = 22;
/** Dead fill glass (unlit amber). */
const FILL_DEAD = 0x2a2116;

/** Cargo hold (`cargo_bay`): a slab hold floor, four muted shipping
 *  containers in a 2 x 2 grid, an X-braced gantry (two rail trusses and a
 *  bridge truss across), worn stripes on the deck ends. */
function cargoHold(c: StyleCtx): void {
  const out = deck(c);
  core(c, chamferBox(-134, -74, 268, 148, 16), SLAB_DARK, 8, Math.PI / 2);
  grime(c, -130, -70, 260, 140, 8, 4);
  let k = 0;
  for (const cy of [-36, 36]) {
    for (const cx of [-64, 64]) {
      const box = chamferBox(cx - 54, cy - 28, 108, 56, 6);
      poly(c, box, CONTAINERS[(c.seed + k++) % 4]!, 'paint', 14, 3, { roof: [2, 8] });
      for (let x = cx - 46; x <= cx + 46; x += 8) poly(c, stripe(box, 0, x, 2), mixColor(SLAB_DARK, 0x000000, 0.3), 'metal', 1, 0.5);
      for (const [ex, ey] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        poly(c, chamferBox(cx + ex * 48 - 4, cy + ey * 22 - 4, 8, 8, 2), SOOT, 'metal', 1.5, 0.6);
      }
      const sy = cy + Math.sign(cy) * BAY_STRIP_OFF;
      glow(c, chamferBox(cx - BAY_STRIP_HW, sy - BAY_STRIP_HH, BAY_STRIP_HW * 2, BAY_STRIP_HH * 2, 1), FILL_DEAD, 0.9);
    }
  }
  grime(c, -120, -64, 240, 128, 8, 5);
  stencil(c, '33', -106, -58, 20);
  for (const s of [-1, 1]) {
    truss(c, [-138, s * 82], [138, s * 82], 14, STEEL, 28);
    wornStripe(c, scalePts(out, 1, 0.8), 0, s * 146, 10, 40 + s);
  }
  truss(c, [12, -90], [12, 90], 20, CRANE, 34);
  poly(c, chamferBox(0, -12, 24, 24, 5), mixColor(CRANE, SLAB_DARK, 0.4), 'metal', 6, 1.5);
  glow(c, chamferBox(6, -3, 12, 6, 2), LAMP_AMBER, 0.8);
  if (c.livery) c.sigils.push({ x: -146, y: 0, r: 9 });
  for (const s of [-1, 1]) lamp(c, 12, s * 86, 3.5, LAMP_AMBER);
}

/** Status strip colours: lit green when powered, dead glass when not. */
const STATUS_LIVE = 0x7fe0a4;
const STATUS_DEAD = 0x1c2620;

/** Storage vault (`storage_vault`, drawn for 480 x 320 and scaled by the
 *  short side): a heavy armoured plinth carrying two banks of three
 *  octagonal sealed silos, each capped by a round blast hatch with a locking
 *  bar, a yellow wheel hub and four clamp dogs; an armoured spine between
 *  the banks carries a segmented status strip (green when powered, dead
 *  glass when not), hazard blocks on the plinth ends. Each hatch's dark
 *  channel ring is the fill gauge: the live overlay lights it amber per
 *  silo full (`VAULT_SILOS`, `status`). */
function storageVault(c: StyleCtx): void {
  const { W, H } = c;
  const k = Math.min(W, H) / 320;
  deck(c);
  const plinth = core(c, chamferBox(-212 * k, -132 * k, 424 * k, 264 * k, 28 * k), SLAB_DARK, 12, Math.PI / 2);
  grime(c, -206 * k, -126 * k, 412 * k, 252 * k, 10, 7);
  for (const s of [-1, 1]) {
    poly(c, chamferBox(s * 201 * k - 7 * k, -44 * k, 14 * k, 88 * k, 3 * k), HAZARD, 'hazard', 14, 1.5);
    wornStripe(c, plinth, Math.PI / 2, s * 124 * k, 8 * k, 70 + s);
  }
  const status = c.live ? STATUS_LIVE : STATUS_DEAD;
  let n = 0;
  for (const cy of [-66 * k, 66 * k]) {
    for (const cx of [-136 * k, 0, 136 * k]) {
      core(c, ngon(cx, cy, 54 * k, 8, Math.PI / 8), mixColor(SLAB, STEEL, 0.25), 26, Math.PI / 2);
      const side = Math.sign(cy);
      rivets(c, [cx - 20 * k, cy + side * 44 * k], [cx + 20 * k, cy + side * 44 * k], 10 * k);
      poly(c, ngon(cx, cy, 36 * k, 16), SOOT, 'metal', -4, 2);
      poly(c, ngon(cx, cy, 31 * k, 16), SLAB_LIGHT, 'metal', 6, 2.5, { roof: [2, 8 * k] });
      const a = ((c.seed + n++) % 3) * (Math.PI / 6) - Math.PI / 6;
      const ux = Math.cos(a) * 28 * k, uy = Math.sin(a) * 28 * k;
      poly(c, strip([cx - ux, cy - uy], [cx + ux, cy + uy], 7 * k), STEEL, 'metal', 9, 1.5);
      poly(c, ngon(cx, cy, 9 * k, 8, Math.PI / 8), CRANE, 'paint', 11, 1.5);
      for (let i = 0; i < 4; i++) {
        const d = Math.PI / 4 + (i * Math.PI) / 2, r = 42 * k;
        const dx = cx + Math.cos(d) * r, dy = cy + Math.sin(d) * r;
        poly(c, chamferBox(dx - 5 * k, dy - 5 * k, 10 * k, 10 * k, 2.5 * k), SOOT, 'metal', 4, 1);
      }
      glow(c, chamferBox(cx - 9 * k, cy - side * 46 * k - 2 * k, 18 * k, 4 * k, 1.5), status, 0.85);
    }
  }
  core(c, chamferBox(-198 * k, -10 * k, 396 * k, 20 * k, 6 * k), SLAB_LIGHT, 30, 0);
  for (let i = -5; i <= 5; i++) glow(c, chamferBox(i * 34 * k - 12 * k, -3 * k, 24 * k, 6 * k, 1.5), status, 0.9);
  stencil(c, '08', -196 * k, 138 * k, 16 * k);
  if (c.livery) c.sigils.push({ x: 186 * k, y: -112 * k, r: 10 * k });
  for (const s of [-1, 1]) lamp(c, s * 190 * k, 0, 3.5 * k, LAMP_AMBER);
}

/** Lived-in window glass: warm lit, a dimmer "curtains drawn" warm, and the
 *  dead glass every window shows when unpowered. */
export const WINDOW_WARM = 0xffc46a;
export const WINDOW_DIM = 0x8a5a2c;
export const WINDOW_DEAD = 0x1e1a16;
/** The spire's red aviation beacon. */
const BEACON_RED = 0xff3a2e;

/** One window slit on a ring: centred at angle `a`, radius `r`, `len` long
 *  (tangential), `d` deep (radial). */
function ringSlit(a: number, r: number, len: number, d: number): Pt[] {
  const cx = Math.cos(a), sy = Math.sin(a), tx = -sy * (len / 2), ty = cx * (len / 2);
  const p = (rr: number, s: number): Pt => [cx * rr + tx * s, sy * rr + ty * s];
  return [p(r - d / 2, -1), p(r - d / 2, 1), p(r + d / 2, 1), p(r + d / 2, -1)];
}

/** A window's glass: dead unpowered, else mostly warm with a seeded few
 *  dimmed (lived in, not a lit sign). */
function windowGlass(c: StyleCtx, r: () => number): number {
  if (!c.live) return WINDOW_DEAD;
  return r() < 0.78 ? WINDOW_WARM : WINDOW_DIM;
}

/** Habitat (`habitat_module`, drawn for 360 x 240, scaled by the short
 *  side): a lived-in crew module. An octagonal central hub (a ring of warm
 *  window slits round a crane-yellow access hatch) carries four chamfered
 *  crew pods on ribbed pressure tubes, one per quadrant, each with a row of
 *  warm window slits on its outer wall and worn accent stripes; a pressure
 *  tube runs out to a hazard-rimmed docking collar on each ±x end (the
 *  sockets sit on those sides); service trusses run along the ±y edges.
 *  Unpowered, every window goes to dead glass. */
function habitat(c: StyleCtx): void {
  const { W, H } = c;
  const k = Math.min(W, H) / 240;
  const r = rng(c.seed * 6151 + 3);
  deck(c);
  grime(c, -160 * k, -100 * k, 320 * k, 200 * k, 10, 11);
  for (const s of [-1, 1]) truss(c, [-120 * k, s * 100 * k], [120 * k, s * 100 * k], 14 * k, STEEL, 10);
  // Docking collars on ±x, fed by pressure tubes from the hub.
  for (const s of [-1, 1]) {
    poly(c, strip([s * 40 * k, 0], [s * 150 * k, 0], 20 * k), STEEL, 'metal', 12, 1.5);
    for (let x = 60; x <= 136; x += 12) poly(c, strip([s * x * k, -11 * k], [s * x * k, 11 * k], 3 * k), SLAB_LIGHT, 'metal', 13, 0.6);
    const cx = s * 160 * k;
    poly(c, chamferBox(cx - 14 * k, -24 * k, 28 * k, 48 * k, 8 * k), HAZARD, 'hazard', 14, 1.5);
    poly(c, chamferBox(cx - 9 * k, -17 * k, 18 * k, 34 * k, 5 * k), SLAB_DARK, 'metal', 15, 1.5);
    poly(c, chamferBox(cx - 5 * k, -11 * k, 10 * k, 22 * k, 3 * k), SOOT, 'metal', -3, 1);
  }
  // Crew pods, one per quadrant, on ribbed tubes from the hub.
  let n = 0;
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const cx = sx * 106 * k, cy = sy * 58 * k;
      poly(c, strip([sx * 30 * k, sy * 18 * k], [cx - sx * 30 * k, cy - sy * 10 * k], 16 * k), STEEL, 'metal', 11, 1.2);
      const pod = core(c, chamferBox(cx - 42 * k, cy - 25 * k, 84 * k, 50 * k, 12 * k), mixColor(SLAB, STEEL, 0.2), 22, Math.PI / 2);
      wornStripe(c, pod, 0, cx - sx * 30 * k, 6 * k, 80 + n);
      rivets(c, [cx - 30 * k, cy - sy * 18 * k], [cx + 30 * k, cy - sy * 18 * k], 10 * k, 1.8 * k);
      for (let x = -28; x <= 28; x += 11) {
        glow(c, chamferBox(cx + x * k - 4 * k, cy + sy * 16 * k - 2.5 * k, 8 * k, 5 * k, 1.2), windowGlass(c, r), 0.85);
      }
      poly(c, chamferBox(cx - 10 * k, cy - 7 * k, 20 * k, 14 * k, 4 * k), SLAB_DARK, 'metal', 24, 1);
      n++;
    }
  }
  // The hub: an octagonal slab, a ring of window slits, the access hatch.
  const hub = core(c, ngon(0, 0, 48 * k, 8, Math.PI / 8), SLAB_LIGHT, 30, 0);
  wornStripe(c, hub, Math.PI / 2, -30 * k, 6 * k, 90);
  for (let i = 0; i < 12; i++) glow(c, ringSlit((i + 0.5) * (Math.PI / 6), 38 * k, 10 * k, 4 * k), windowGlass(c, r), 0.85);
  poly(c, ngon(0, 0, 24 * k, 8, Math.PI / 8), SOOT, 'metal', -3, 1.5);
  poly(c, ngon(0, 0, 19 * k, 16), SLAB, 'metal', 6, 2, { roof: [2, 6 * k] });
  poly(c, strip([-15 * k, 0], [15 * k, 0], 5 * k), STEEL, 'metal', 9, 1);
  poly(c, ngon(0, 0, 6 * k, 8, Math.PI / 8), CRANE, 'paint', 10, 1);
  weld(c, [-34 * k, 30 * k], [34 * k, 30 * k]);
  stencil(c, '42', 74 * k, -24 * k, 14 * k);
  if (c.livery) c.sigils.push({ x: -106 * k, y: 58 * k, r: 9 * k });
  for (const s of [-1, 1]) {
    lamp(c, s * 160 * k, s * 30 * k, 3.5 * k, LAMP_AMBER);
    lamp(c, s * 146 * k, -s * 82 * k, 3 * k, LAMP_WHITE);
  }
}

/** Residential spire (`tower_module`, drawn for 240 x 240, scaled by the
 *  short side), seen from above: three stacked octagonal tiers stepping up
 *  to a crown, each tier ringed by warm window slits on its outer wall
 *  (dead glass unpowered); four diagonal buttress trusses brace the base to
 *  bolted foot pads with work lamps; on the crown an X of antenna lattice
 *  round a mast cap carrying the red aviation beacon. */
function spire(c: StyleCtx): void {
  const { W, H } = c;
  const k = Math.min(W, H) / 240;
  const r = rng(c.seed * 4421 + 5);
  deck(c);
  grime(c, -100 * k, -100 * k, 200 * k, 200 * k, 8, 13);
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    truss(c, [sx * 58 * k, sy * 58 * k], [sx * 84 * k, sy * 84 * k], 14 * k, STEEL, 10);
    poly(c, chamferBox(sx * 86 * k - 11 * k, sy * 86 * k - 11 * k, 22 * k, 22 * k, 5 * k), SLAB_LIGHT, 'metal', 12, 1.5);
    poly(c, ngon(sx * 86 * k, sy * 86 * k, 4.5 * k, 6), RIVET, 'metal', 14, 0.6);
  }
  const base = core(c, ngon(0, 0, 92 * k, 8, Math.PI / 8), SLAB_DARK, 18, Math.PI / 2);
  for (const s of [-1, 1]) wornStripe(c, base, Math.PI / 2, s * 72 * k, 7 * k, 30 + s);
  const tiers = [[92, 18, SLAB_DARK, 24], [66, 34, SLAB, 16], [42, 50, SLAB_LIGHT, 12]] as const;
  for (const [i, [rad, lift, col, nWin]] of tiers.entries()) {
    if (i > 0) core(c, ngon(0, 0, rad * k, 8, Math.PI / 8), col, lift, i % 2 ? 0 : Math.PI / 2);
    const wr = rad * 0.84 * k;
    for (let w = 0; w < nWin; w++) {
      glow(c, ringSlit(((w + 0.5) * Math.PI * 2) / nWin, wr, wr * 0.16, 4 * k), windowGlass(c, r), 0.85);
    }
    if (i < 2) rivets(c, [-rad * 0.36 * k, -rad * 0.66 * k], [rad * 0.36 * k, -rad * 0.66 * k], 9 * k, 1.6 * k);
  }
  for (const s of [-1, 1]) poly(c, chamferBox(-6 * k, s * 54 * k - 3 * k, 12 * k, 6 * k, 1.5 * k), HAZARD, 'hazard', 36, 0.8);
  // Crown: antenna lattice in an X, a mast cap, the beacon.
  truss(c, [-30 * k, -30 * k], [30 * k, 30 * k], 7 * k, STEEL, 60);
  truss(c, [-30 * k, 30 * k], [30 * k, -30 * k], 7 * k, STEEL, 60);
  poly(c, ngon(0, 0, 13 * k, 8, Math.PI / 8), SOOT, 'metal', 62, 1.5);
  poly(c, ngon(0, 0, 9 * k, 8, Math.PI / 8), CRANE, 'paint', 64, 1.2);
  glow(c, ngon(0, 0, 4 * k, 8), c.live ? BEACON_RED : WINDOW_DEAD, 0.95);
  lamp(c, 0, 0, 5 * k, BEACON_RED);
  stencil(c, '07', -12 * k, 72 * k, 12 * k);
  if (c.livery) c.sigils.push({ x: -52 * k, y: 30 * k, r: 7 * k });
  lamp(c, -86 * k, -86 * k, 3 * k, LAMP_AMBER);
  lamp(c, 86 * k, 86 * k, 3 * k, LAMP_WHITE);
}

/** Storage vault silos (drawn at 480 x 320, × k for other sizes), in fill
 *  order: the +y (bottom) bank first, left to right. */
export const VAULT_SILOS: readonly (readonly [number, number])[] = [
  [-136, 66], [0, 66], [136, 66], [-136, -66], [0, -66], [136, -66],
];
/** The silo hatch's dark channel ring (between the 31 and 36 rings). */
const VAULT_RING_R = 33.5;

// ── Live fill gauge (BodyStatusHook) ────────────────────────────────────────

/** Lit fill: the charge amber of the battery cells, a hot core. */
const FILL_LIT = 0xffb24a;
const FILL_HOT = 0xffe2a8;
const _fill = { color: 0, alpha: 0 };
const _stroke = { color: 0, alpha: 0, width: 0 };

/** Lit units (of `n`) for a row: its `fillPct` rounded to whole units, at
 *  least one while anything is stored; 0 unbuilt. */
export function fillUnits(st: StructureRenderState | undefined, n: number): number {
  if (st === undefined || !st.built) return 0;
  const pct = st.fillPct ?? 0;
  if (!(pct > 0)) return 0;
  return Math.min(n, Math.max(1, Math.round((Math.min(100, pct) / 100) * n)));
}

/** Vault: one lit silo ring per sixth full. */
function vaultCode(_kind: StructureKindId, st: StructureRenderState | undefined): number {
  return fillUnits(st, VAULT_SILOS.length);
}

/** Light the first `code` silo hatch rings (a halo, the lit ring, a hot
 *  inner line). */
function drawVaultFill(g: GraphicsContext, code: number, kind: StructureKindId): void {
  const fp = getStructureKind(kind).footprint;
  const k = Math.min(fp.w, fp.h) / 320;
  for (let i = 0; i < code && i < VAULT_SILOS.length; i++) {
    const [sx, sy] = VAULT_SILOS[i]!;
    const x = sx * k, y = sy * k, r = VAULT_RING_R * k;
    g.circle(x, y, r); _stroke.color = FILL_LIT; _stroke.alpha = 0.22; _stroke.width = 10 * k; g.stroke(_stroke);
    g.circle(x, y, r); _stroke.color = FILL_LIT; _stroke.alpha = 0.9; _stroke.width = 3.6 * k; g.stroke(_stroke);
    g.circle(x, y, r); _stroke.color = FILL_HOT; _stroke.alpha = 0.7; _stroke.width = 1.2 * k; g.stroke(_stroke);
  }
}

/** Cargo bay: one lit container strip per quarter full. */
function bayCode(_kind: StructureKindId, st: StructureRenderState | undefined): number {
  return fillUnits(st, BAY_CONTAINERS.length);
}

/** Light the first `code` containers' fill strips (a halo, the lit strip,
 *  a hot core line). */
function drawBayFill(g: GraphicsContext, code: number, kind: StructureKindId): void {
  const fp = getStructureKind(kind).footprint;
  const k = Math.min(fp.w / 320, fp.h / 200);
  for (let i = 0; i < code && i < BAY_CONTAINERS.length; i++) {
    const [cx, cy] = BAY_CONTAINERS[i]!;
    const x = cx * k, y = (cy + Math.sign(cy) * BAY_STRIP_OFF) * k, hw = BAY_STRIP_HW * k, hh = BAY_STRIP_HH * k;
    g.rect(x - hw - 3 * k, y - hh - 3 * k, (hw + 3 * k) * 2, (hh + 3 * k) * 2); _fill.color = FILL_LIT; _fill.alpha = 0.2; g.fill(_fill);
    g.rect(x - hw, y - hh, hw * 2, hh * 2); _fill.color = FILL_LIT; _fill.alpha = 0.9; g.fill(_fill);
    g.rect(x - hw + 2 * k, y - hh * 0.35, (hw - 2 * k) * 2, hh * 0.7); _fill.color = FILL_HOT; _fill.alpha = 0.7; g.fill(_fill);
  }
}

/** This family's live body state (`BodyStatusHook`, drawn on the socket-nub
 *  overlay, structureSocketNubs.ts): the fill gauges from the row's
 *  `fillPct`. */
export const status: BodyStatusHookTable = {
  storage_vault: { code: vaultCode, draw: drawVaultFill } satisfies BodyStatusHook,
  cargo_bay: { code: bayCode, draw: drawBayFill } satisfies BodyStatusHook,
};

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  cargo_bay: cargoHold,
  storage_vault: storageVault,
  habitat_module: habitat,
  tower_module: spire,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
