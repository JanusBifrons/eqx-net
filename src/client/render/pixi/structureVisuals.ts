/**
 * Architectural draw plans for structures (plan soft-leaping-truffle v2,
 * phase V — user: "redesign the size and shape of the structures to be far
 * larger and more like the other ones you made").
 *
 * Each structure kind gets a rectangular (or composite) FOOTPRINT several
 * times larger than the old regular-polygon silhouette, drawn with the same
 * vocabulary as the warehouse/city bases (baseVisuals.ts): three flat tones, a
 * rim, functional detail (panel grids, container ribs, cell rows, windows) and
 * point lights. Pure + deterministic (no Pixi): returns rect/light ops in
 * LOCAL pixi space centred on the structure, so one plan feeds the in-game
 * renderer (a retained Graphics per structure) and the offline design sheet.
 *
 * `PROPOSED_FOOTPRINTS` is the design proposal; phase V moves the agreed
 * numbers into the structure catalogue (collider + placement + LOS).
 */
import type { LightOp, RectOp } from './baseVisuals.js';
import { mixColor } from './baseVisuals.js';
import { getStructureKind, isStructureKindId } from '../../../shared-types/structureKinds.js';

export interface StructureFootprint {
  /** Full width / height (u). */
  w: number;
  h: number;
}

export const PROPOSED_FOOTPRINTS: Readonly<Record<string, StructureFootprint>> = {
  capital: { w: 560, h: 560 },
  connector: { w: 64, h: 64 },
  solar: { w: 360, h: 150 },
  miner: { w: 240, h: 240 },
  turret: { w: 140, h: 140 },
  battery: { w: 190, h: 190 },
  shield_pylon: { w: 72, h: 72 },
  laser_bolt_turret: { w: 150, h: 150 },
  missile_turret: { w: 190, h: 190 },
  cargo_bay: { w: 320, h: 200 },
  // User request 2026-11-01 — gates. A Shield Gate is ONE structure: two gate
  // posts placed together with a shield span between them that opens when an
  // allowed ship approaches. A Shield Airlock is a chamber with a shield gate at
  // each end; it opens one end or the other, never both.
  shield_gate: { w: 320, h: 72 },
  shield_airlock: { w: 320, h: 260 },
};

/** Gate / airlock shield state for the draw plan (from room state at runtime). */
export type GateState = 'closed' | 'open' | 'openA' | 'openB';

export interface StructureVisual {
  rects: RectOp[];
  lights: LightOp[];
  footprint: StructureFootprint;
}

export interface StructureVisualOpts {
  /** Catalogue tint (`StructureKind.color`) — the kind's accent. */
  accent: number;
  built?: boolean;
  powered?: boolean;
  /** Per-instance variety (deterministic). */
  seed?: number;
  /** Shield Gate: 'open' | 'closed'. Shield Airlock: 'openA' | 'openB' | 'closed'. */
  gate?: GateState;
  /** Override the footprint (kindless test structures sized by radius). */
  size?: StructureFootprint;
  /** Gates in game: leave the shield spans out — the renderer draws them live
   *  from the open state (ConnectorRenderer via derivedWalls). */
  omitSpans?: boolean;
}

/** A gate shield span between two posts: bright when closed, a faint ghost
 *  line when open. Horizontal span from x0..x1 at y, thickness t. */
function shieldSpan(out: RectOp[], lights: LightOp[], x0: number, x1: number, y: number, t: number, open: boolean, accent: number, live: boolean): void {
  if (open || !live) {
    // Open: two short stubs at the posts + a faint dashed guide.
    for (let x = x0; x < x1; x += 28) out.push({ x, y: y - 1, w: 12, h: 2, color: accent, alpha: 0.35 });
    return;
  }
  out.push({ x: x0, y: y - t / 2, w: x1 - x0, h: t, color: accent, alpha: 0.28 });
  out.push({ x: x0, y: y - t / 6, w: x1 - x0, h: Math.max(2, t / 3), color: mixColor(accent, 0xffffff, 0.5), alpha: 0.85 });
  lights.push({ x: (x0 + x1) / 2, y, r: 8, color: accent });
}

/** A gate post (the shield emitter block at either end of a gate). */
function gatePost(out: RectOp[], x: number, y: number, size: number, accent: number): void {
  slab(out, x - size / 2, y - size / 2, size, size, STEEL_DARK, 6);
  box(out, x - size / 2 + 12, y - size / 2 + 12, size - 24, size - 24, STEEL);
  box(out, x - 8, y - 8, 16, 16, mixColor(accent, 0xffffff, 0.3));
}

const STEEL = 0x6b7a8f;
const STEEL_DARK = 0x3c4656;
const STEEL_LIGHT = 0x9aa8bb;
const DECK = 0x1d2433;
const GLASS = 0x7cf7ff;
const WARM = 0xffd27a;
const RED = 0xff4d5e;

function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function box(out: RectOp[], x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
  out.push({ x, y, w, h, color, alpha });
}

/** Body with a darker rim and a lighter top face (the base-piece look). */
function slab(out: RectOp[], x: number, y: number, w: number, h: number, base: number, rim = 6): void {
  box(out, x, y, w, h, mixColor(base, 0x000000, 0.35));
  box(out, x + rim, y + rim, w - 2 * rim, h - 2 * rim, base);
  box(out, x + rim, y + rim, w - 2 * rim, Math.max(2, Math.floor(rim / 2)), mixColor(base, 0xffffff, 0.18));
}

function hazard(out: RectOp[], x: number, y: number, w: number, h: number): void {
  const t = 6;
  for (let s = 0; s < w; s += 24) {
    box(out, x + s, y, Math.min(12, w - s), t, 0xe8c547, 0.85);
    box(out, x + s, y + h - t, Math.min(12, w - s), t, 0xe8c547, 0.85);
  }
}

export function buildStructureVisual(kindId: string, opts: StructureVisualOpts): StructureVisual {
  // Catalogue kinds use the catalogue footprint (the collider's source);
  // not-yet-catalogued designs (gates) use the proposal table.
  const fp = opts.size
    ?? (isStructureKindId(kindId) ? getStructureKind(kindId).footprint : PROPOSED_FOOTPRINTS[kindId] ?? { w: 80, h: 80 });
  const rects: RectOp[] = [];
  const lights: LightOp[] = [];
  const W = fp.w, H = fp.h, x0 = -W / 2, y0 = -H / 2;
  const accent = opts.accent;
  const seed = opts.seed ?? 1;
  const live = opts.powered !== false;
  const lit = (x: number, y: number, r: number, c: number): void => {
    if (live) lights.push({ x, y, r, color: c });
  };

  switch (kindId) {
    case 'capital': {
      // Command complex: a deck, four wing blocks, a raised core with a
      // landing pad, window bands and corner beacons.
      box(rects, x0, y0, W, H, DECK, 0.95);
      const wing = 150;
      slab(rects, x0, y0, wing, wing, STEEL, 8);
      slab(rects, x0 + W - wing, y0, wing, wing, STEEL, 8);
      slab(rects, x0, y0 + H - wing, wing, wing, STEEL, 8);
      slab(rects, x0 + W - wing, y0 + H - wing, wing, wing, STEEL, 8);
      // Connecting halls.
      slab(rects, x0 + wing, y0 + 40, W - 2 * wing, 70, STEEL_DARK, 6);
      slab(rects, x0 + wing, y0 + H - 110, W - 2 * wing, 70, STEEL_DARK, 6);
      slab(rects, x0 + 40, y0 + wing, 70, H - 2 * wing, STEEL_DARK, 6);
      slab(rects, x0 + W - 110, y0 + wing, 70, H - 2 * wing, STEEL_DARK, 6);
      // Core.
      const c = 220;
      slab(rects, -c / 2, -c / 2, c, c, STEEL_LIGHT, 10);
      box(rects, -c / 2 + 30, -c / 2 + 30, c - 60, c - 60, mixColor(accent, STEEL_DARK, 0.55));
      // Landing pad cross.
      box(rects, -60, -4, 120, 8, 0xe8edf6, 0.85);
      box(rects, -4, -60, 8, 120, 0xe8edf6, 0.85);
      // Window bands on the wings.
      for (const [wx, wy] of [[x0, y0], [x0 + W - wing, y0], [x0, y0 + H - wing], [x0 + W - wing, y0 + H - wing]] as const) {
        for (let r = 0; r < 4; r++) {
          for (let k = 0; k < 6; k++) {
            const warm = (hash(seed, r * 31 + k + wx) & 7) === 0;
            box(rects, wx + 22 + k * 19, wy + 26 + r * 28, 10, 6, warm ? WARM : mixColor(GLASS, STEEL, 0.5), warm ? 0.95 : 0.6);
          }
        }
      }
      lit(x0 + 14, y0 + 14, 10, RED);
      lit(x0 + W - 14, y0 + 14, 10, RED);
      lit(x0 + 14, y0 + H - 14, 10, RED);
      lit(x0 + W - 14, y0 + H - 14, 10, RED);
      lit(0, 0, 26, accent);
      break;
    }
    case 'connector': {
      // Hub pylon: braced square with a lit core.
      slab(rects, x0, y0, W, H, STEEL_DARK, 6);
      box(rects, x0 + 10, -3, W - 20, 6, STEEL_LIGHT);
      box(rects, -3, y0 + 10, 6, H - 20, STEEL_LIGHT);
      box(rects, -10, -10, 20, 20, mixColor(accent, 0xffffff, 0.2));
      lit(0, 0, 9, accent);
      break;
    }
    case 'solar': {
      // Panel array: a frame of cell panels either side of a spine.
      box(rects, x0, -6, W, 12, STEEL_DARK);
      const panelH = (H - 24) / 2;
      for (const py of [y0, 12]) {
        box(rects, x0, py, W, panelH, mixColor(STEEL_DARK, 0x000000, 0.2));
        for (let cx = x0 + 6; cx < x0 + W - 6; cx += 30) {
          const cw = Math.min(26, x0 + W - 6 - cx); // last cell stays inside the footprint
          box(rects, cx, py + 5, cw, panelH - 10, mixColor(0x1f4f9a, accent, 0.25), live ? 1 : 0.6);
          box(rects, cx, py + 5, cw, 3, 0x9fc3ff, 0.5);
        }
      }
      box(rects, -16, -16, 32, 32, STEEL);
      lit(0, 0, 7, live ? 0x9fc3ff : 0x445566);
      break;
    }
    case 'battery': {
      // Cell bank: a grid of cells with charge bars.
      slab(rects, x0, y0, W, H, STEEL_DARK, 8);
      const cell = 38;
      for (let r = 0; r < 4; r++) {
        for (let k = 0; k < 4; k++) {
          const cx = x0 + 16 + k * (cell + 4), cy = y0 + 16 + r * (cell + 4);
          box(rects, cx, cy, cell, cell, STEEL);
          box(rects, cx + 6, cy + cell - 12, cell - 12, 6, live ? accent : 0x553322, 0.95);
        }
      }
      lit(x0 + W - 12, y0 + 12, 6, live ? 0x7fe0a4 : RED);
      break;
    }
    case 'cargo_bay': {
      // Container block: stacked, ribbed containers on a hazard-rimmed pad.
      box(rects, x0, y0, W, H, DECK, 0.95);
      hazard(rects, x0, y0, W, H);
      const cw = 92, ch = 52;
      for (let r = 0; r < 3; r++) {
        for (let k = 0; k < 3; k++) {
          const tint = [0x3f8f92, 0xb9772f, 0x5a6e9a][(hash(seed, r * 3 + k) % 3)]!;
          const cx = x0 + 14 + k * (cw + 10), cy = y0 + 14 + r * (ch + 9);
          slab(rects, cx, cy, cw, ch, tint, 4);
          for (let s = cx + 10; s < cx + cw - 6; s += 12) box(rects, s, cy + 6, 2, ch - 12, mixColor(tint, 0x000000, 0.3));
        }
      }
      lit(x0 + 8, y0 + 8, 6, WARM);
      lit(x0 + W - 8, y0 + H - 8, 6, WARM);
      break;
    }
    case 'turret':
    case 'laser_bolt_turret':
    case 'missile_turret':
    case 'autocannon_turret': {
      // Armoured emplacement: chamfered base plates + a turret ring (the
      // rotating barrel is drawn by the mount visuals on top).
      slab(rects, x0 + 14, y0, W - 28, H, STEEL_DARK, 6);
      slab(rects, x0, y0 + 14, W, H - 28, STEEL_DARK, 6);
      box(rects, x0 + 22, y0 + 22, W - 44, H - 44, STEEL);
      const ring = Math.floor(W * 0.42);
      box(rects, -ring / 2, -ring / 2, ring, ring, mixColor(accent, STEEL_DARK, 0.45));
      if (kindId === 'missile_turret') {
        for (let k = 0; k < 4; k++) box(rects, x0 + 26 + k * 38, y0 + 26, 28, 18, 0x222833);
      }
      lit(x0 + 18, y0 + 18, 5, RED);
      lit(x0 + W - 18, y0 + H - 18, 5, RED);
      break;
    }
    case 'miner': {
      // Mining rig: platform, ore hopper, drill boom.
      box(rects, x0, y0, W, H, DECK, 0.95);
      hazard(rects, x0, y0, W, H);
      slab(rects, x0 + 20, y0 + 20, W * 0.55, H * 0.55, STEEL, 8);
      slab(rects, x0 + W * 0.55, y0 + H * 0.55, W * 0.38, H * 0.38, mixColor(accent, STEEL_DARK, 0.4), 6);
      box(rects, -8, y0 + 20, 16, H - 40, STEEL_LIGHT);
      lit(0, 0, 10, accent);
      break;
    }
    case 'shield_pylon': {
      // Emitter tower: a tall braced post with an emitter ring.
      slab(rects, x0, y0, W, H, STEEL_DARK, 6);
      box(rects, -14, -14, 28, 28, mixColor(accent, 0xffffff, 0.3));
      lit(0, 0, 16, accent);
      break;
    }
    case 'shield_gate': {
      // Two posts (placed as one structure) with a shield span between them.
      const post = H;
      gatePost(rects, x0 + post / 2, 0, post, accent);
      gatePost(rects, x0 + W - post / 2, 0, post, accent);
      if (!opts.omitSpans) {
        shieldSpan(rects, lights, x0 + post, x0 + W - post, 0, 22, opts.gate === 'open', accent, live);
        lit(x0 + post / 2, 0, 9, opts.gate === 'open' ? 0x7fe0a4 : RED);
        lit(x0 + W - post / 2, 0, 9, opts.gate === 'open' ? 0x7fe0a4 : RED);
      }
      break;
    }
    case 'shield_airlock': {
      // A chamber: two solid side walls, a shield gate at each end (A = top,
      // B = bottom in local space). Never both open.
      const wall = 40, post = 64;
      box(rects, x0, y0, W, H, DECK, 0.9);
      slab(rects, x0, y0 + post / 2, wall, H - post, STEEL_DARK, 6);
      slab(rects, x0 + W - wall, y0 + post / 2, wall, H - post, STEEL_DARK, 6);
      for (let y = y0 + post; y < y0 + H - post; y += 24) box(rects, x0 + wall + 10, y, W - 2 * wall - 20, 2, mixColor(STEEL, DECK, 0.6));
      for (const ey of [y0 + post / 2, y0 + H - post / 2]) {
        gatePost(rects, x0 + post / 2, ey, post, accent);
        gatePost(rects, x0 + W - post / 2, ey, post, accent);
      }
      const g = opts.gate ?? 'closed';
      if (!opts.omitSpans) {
        shieldSpan(rects, lights, x0 + post, x0 + W - post, y0 + post / 2, 20, g === 'openA', accent, live);
        shieldSpan(rects, lights, x0 + post, x0 + W - post, y0 + H - post / 2, 20, g === 'openB', accent, live);
        // Cycle indicator: which end may open next.
        lit(x0 + W / 2, 0, 10, g === 'closed' ? RED : 0x7fe0a4);
      }
      break;
    }
    // ── Production chains (plan soft-leaping-truffle v3, P2a) ──────────────
    case 'gas_collector': {
      // Intake array: a ring of scoop vanes round a compressor drum.
      box(rects, x0, y0, W, H, DECK, 0.9);
      const r = Math.min(W, H) / 2 - 10;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const cx = Math.cos(a) * (r - 30), cy = Math.sin(a) * (r - 30);
        slab(rects, cx - 22, cy - 22, 44, 44, mixColor(accent, STEEL_DARK, 0.5), 4);
      }
      slab(rects, -60, -60, 120, 120, STEEL, 8);
      box(rects, -30, -30, 60, 60, mixColor(accent, 0xffffff, 0.15));
      lit(0, 0, 14, accent);
      break;
    }
    case 'reclaimer': {
      // Scrap hopper and crusher: a hazard pad, an intake hopper, a crusher block.
      box(rects, x0, y0, W, H, DECK, 0.95);
      hazard(rects, x0, y0, W, H);
      slab(rects, x0 + 14, y0 + 14, W * 0.45, H - 28, STEEL_DARK, 6);
      for (let y = y0 + 30; y < y0 + H - 24; y += 18) box(rects, x0 + 24, y, W * 0.45 - 20, 4, mixColor(STEEL, 0x000000, 0.3));
      slab(rects, x0 + W * 0.55, y0 + 30, W * 0.38, H - 60, mixColor(accent, STEEL, 0.45), 6);
      lit(x0 + W - 18, y0 + 18, 6, WARM);
      break;
    }
    case 'smelter': {
      // Furnace hall: two blast furnaces with glowing mouths and a stack.
      slab(rects, x0, y0, W, H, STEEL_DARK, 8);
      const fw = (W - 60) / 2;
      for (let k = 0; k < 2; k++) {
        const fx = x0 + 20 + k * (fw + 20);
        slab(rects, fx, y0 + 24, fw, H - 48, STEEL, 8);
        box(rects, fx + fw / 2 - 24, y0 + H - 70, 48, 26, live ? 0xff7a2a : 0x553322, 0.95);
        lit(fx + fw / 2, y0 + H - 57, 14, 0xff7a2a);
      }
      box(rects, x0 + W / 2 - 14, y0 + 30, 28, 60, STEEL_LIGHT);
      break;
    }
    case 'refinery': {
      // Tank farm and cracking column: round-ish tanks (squares) and pipes.
      box(rects, x0, y0, W, H, DECK, 0.9);
      const t = 96;
      for (let r = 0; r < 2; r++) {
        for (let k = 0; k < 2; k++) {
          const tx = x0 + 18 + k * (t + 14), ty = y0 + 18 + r * (t + 40);
          slab(rects, tx, ty, t, t, mixColor(accent, STEEL, 0.5), 10);
          box(rects, tx + 20, ty + 20, t - 40, t - 40, mixColor(accent, 0xffffff, 0.1), 0.8);
        }
      }
      slab(rects, x0 + W - 110, y0 + 20, 80, H - 40, STEEL, 6);
      for (let y = y0 + 40; y < y0 + H - 40; y += 30) box(rects, x0 + W - 100, y, 60, 6, STEEL_LIGHT);
      box(rects, x0 + 18, y0 + H / 2 - 4, W - 140, 8, STEEL_LIGHT, 0.8);
      lit(x0 + W - 70, y0 + 30, 8, RED);
      break;
    }
    case 'silicon_works': {
      // Clean-room grid: wafer cells under glass.
      slab(rects, x0, y0, W, H, STEEL_DARK, 8);
      const c = 56;
      for (let r = 0; r < 4; r++) {
        for (let k = 0; k < 4; k++) {
          const cx = x0 + 24 + k * (c + 12), cy = y0 + 24 + r * (c + 12);
          box(rects, cx, cy, c, c, mixColor(GLASS, STEEL_DARK, 0.6), 0.9);
          box(rects, cx + 14, cy + 14, c - 28, c - 28, mixColor(accent, 0xffffff, 0.2), live ? 0.9 : 0.4);
        }
      }
      lit(0, 0, 12, accent);
      break;
    }
    case 'hydroponics': {
      // Greenhouse: long glazed bays of green growth.
      slab(rects, x0, y0, W, H, STEEL_DARK, 6);
      const bays = 4, bw = (W - 30) / bays;
      for (let k = 0; k < bays; k++) {
        const bx = x0 + 15 + k * bw;
        box(rects, bx + 4, y0 + 16, bw - 8, H - 32, mixColor(GLASS, STEEL_DARK, 0.7), 0.85);
        for (let y = y0 + 26; y < y0 + H - 26; y += 16) box(rects, bx + 10, y, bw - 20, 8, live ? 0x4fbf5a : 0x2f4f33, 0.9);
      }
      lit(x0 + 12, 0, 6, WARM);
      break;
    }
    case 'fabricator': {
      // Fabrication hall: a long assembly line with robot cells either side.
      slab(rects, x0, y0, W, H, STEEL_DARK, 10);
      box(rects, x0 + 30, -14, W - 60, 28, STEEL_LIGHT);
      for (let k = 0; k < 5; k++) {
        const cx = x0 + 40 + k * ((W - 80) / 5);
        for (const cy of [y0 + 30, 30]) {
          slab(rects, cx, cy, 60, H / 2 - 60, mixColor(accent, STEEL, 0.55), 5);
        }
        box(rects, cx + 22, -6, 16, 12, live ? accent : 0x553322);
      }
      lit(x0 + 20, y0 + 20, 8, RED);
      lit(x0 + W - 20, y0 + H - 20, 8, RED);
      break;
    }
    case 'munitions_works': {
      // Bunkered works: blast-walled shell lines with hazard striping.
      box(rects, x0, y0, W, H, DECK, 0.95);
      hazard(rects, x0, y0, W, H);
      slab(rects, x0 + 16, y0 + 16, W - 32, H - 32, STEEL_DARK, 10);
      for (let r = 0; r < 3; r++) {
        const ry = y0 + 40 + r * ((H - 80) / 3);
        box(rects, x0 + 40, ry, W - 80, 30, STEEL);
        for (let x = x0 + 50; x < x0 + W - 60; x += 26) box(rects, x, ry + 8, 12, 14, mixColor(accent, 0x000000, 0.2));
      }
      lit(0, 0, 10, accent);
      break;
    }
    case 'freight_dock': {
      // A pier: a long berth with mooring clamps and cargo cranes.
      box(rects, x0, y0, W, H, DECK, 0.9);
      slab(rects, x0, y0, W, H * 0.45, STEEL_DARK, 8);
      for (let x = x0 + 30; x < x0 + W - 40; x += 90) {
        slab(rects, x, y0 + H * 0.5, 50, H * 0.42, mixColor(accent, STEEL, 0.5), 5);
        box(rects, x + 10, y0 + 18, 30, H * 0.45 - 30, STEEL_LIGHT, 0.85);
      }
      hazard(rects, x0, y0 + H - 12, W, 12);
      lit(x0 + 14, y0 + H - 20, 7, 0x7fe0a4);
      lit(x0 + W - 14, y0 + H - 20, 7, 0x7fe0a4);
      break;
    }
    case 'deep_core_rig': {
      // Huge drilling platform: a square deck, four corner legs, a central bore.
      box(rects, x0, y0, W, H, DECK, 0.95);
      hazard(rects, x0, y0, W, H);
      const leg = 150;
      for (const [lx, ly] of [[x0, y0], [x0 + W - leg, y0], [x0, y0 + H - leg], [x0 + W - leg, y0 + H - leg]] as const) {
        slab(rects, lx + 10, ly + 10, leg - 20, leg - 20, STEEL, 10);
      }
      slab(rects, -200, -200, 400, 400, STEEL_DARK, 12);
      slab(rects, -110, -110, 220, 220, mixColor(accent, STEEL, 0.4), 10);
      box(rects, -40, -40, 80, 80, live ? 0xffa54a : 0x553322, 0.95);
      for (let k = 0; k < 4; k++) box(rects, -8, y0 + 40 + k * 70, 16, 40, STEEL_LIGHT);
      lit(0, 0, 30, accent);
      lit(x0 + 20, y0 + 20, 10, RED);
      lit(x0 + W - 20, y0 + H - 20, 10, RED);
      break;
    }
    case 'ore_processing_complex': {
      // Huge refinery block: furnace row, separator towers, a conveyor spine.
      box(rects, x0, y0, W, H, DECK, 0.95);
      slab(rects, x0 + 20, y0 + 20, W - 40, 150, STEEL_DARK, 10);
      for (let k = 0; k < 5; k++) {
        const fx = x0 + 50 + k * ((W - 100) / 5);
        box(rects, fx, y0 + 60, 90, 70, STEEL);
        box(rects, fx + 20, y0 + 100, 50, 22, live ? 0xff7a2a : 0x553322, 0.95);
      }
      box(rects, x0 + 40, -10, W - 80, 20, STEEL_LIGHT);
      for (let k = 0; k < 4; k++) {
        const tx = x0 + 70 + k * ((W - 140) / 4);
        slab(rects, tx, 40, 120, H / 2 - 80, mixColor(accent, STEEL, 0.5), 8);
      }
      lit(0, 0, 24, accent);
      lit(x0 + 24, y0 + 24, 10, RED);
      lit(x0 + W - 24, y0 + H - 24, 10, RED);
      break;
    }
    case 'assembly_plant': {
      // Huge assembly hall: twin bays, a gantry spine, a roof of skylights.
      box(rects, x0, y0, W, H, DECK, 0.95);
      for (const by of [y0 + 20, 20]) {
        slab(rects, x0 + 20, by, W - 40, H / 2 - 40, STEEL_DARK, 12);
        for (let x = x0 + 50; x < x0 + W - 70; x += 70) {
          box(rects, x, by + 30, 40, H / 2 - 100, mixColor(GLASS, STEEL_DARK, 0.6), 0.85);
        }
      }
      box(rects, x0 + 20, -12, W - 40, 24, STEEL_LIGHT);
      for (let x = x0 + 60; x < x0 + W - 60; x += 120) box(rects, x, -8, 40, 16, live ? accent : 0x553322);
      lit(0, 0, 26, accent);
      lit(x0 + 24, y0 + 24, 10, RED);
      lit(x0 + W - 24, y0 + H - 24, 10, RED);
      break;
    }
    case 'research_lab': {
      // Research lab: a glass-roofed hall around a central test chamber, with
      // two instrument racks either side.
      slab(rects, x0, y0, W, H, STEEL_DARK, 10);
      box(rects, x0 + 24, y0 + 24, W - 48, H - 48, mixColor(GLASS, STEEL_DARK, 0.5), 0.9);
      box(rects, -50, -50, 100, 100, STEEL_LIGHT);
      box(rects, -34, -34, 68, 68, live ? accent : 0x443366, 0.9);
      for (const sx of [x0 + 40, W / 2 - 80]) {
        for (let y = y0 + 44; y < y0 + H - 60; y += 40) box(rects, sx, y, 40, 24, mixColor(accent, STEEL, 0.6), 0.85);
      }
      lit(0, 0, 18, accent);
      lit(x0 + 20, y0 + 20, 8, RED);
      lit(x0 + W - 20, y0 + H - 20, 8, RED);
      break;
    }
    default:
      slab(rects, x0, y0, W, H, mixColor(STEEL, accent, 0.25), 6);
  }
  if (opts.built === false) for (const r of rects) r.alpha *= 0.45;
  return { rects, lights, footprint: fp };
}
