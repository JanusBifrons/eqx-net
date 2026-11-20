/**
 * Style C family "storage" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Storage + habitation: storage vault, habitat, tower, cargo bay.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts), `status` (the fill gauges) into `BODY_STATUS_HOOKS`.
 * Kind -> family: structureFamilies.ts.
 */
import {
  CONTAINERS, CRANE, HAZARD, LAMP_AMBER, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, STEEL, chamferBox, core, deck, glow,
  grime, lamp, mixColor, ngon, poly, rivets, scalePts, stencil, stripe, strip, truss, wornStripe, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';
import type { GraphicsContext } from 'pixi.js';
import type { BodyStatusHook, BodyStatusHookTable } from './structureSocketNubs.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { getStructureKind, type StructureKindId } from '../../../shared-types/structureKinds.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'v2';

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
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
