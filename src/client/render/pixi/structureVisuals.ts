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
};

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
  const fp = PROPOSED_FOOTPRINTS[kindId] ?? { w: 80, h: 80 };
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
          box(rects, cx, py + 5, 26, panelH - 10, mixColor(0x1f4f9a, accent, 0.25), live ? 1 : 0.6);
          box(rects, cx, py + 5, 26, 3, 0x9fc3ff, 0.5);
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
    case 'missile_turret': {
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
    default:
      slab(rects, x0, y0, W, H, mixColor(STEEL, accent, 0.25), 6);
  }
  if (opts.built === false) for (const r of rects) r.alpha *= 0.45;
  return { rects, lights, footprint: fp };
}
