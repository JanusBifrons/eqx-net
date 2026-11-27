/**
 * Architectural draw plans for structures (plan soft-leaping-truffle v2,
 * phase V — user: "redesign the size and shape of the structures to be far
 * larger and more like the other ones you made").
 *
 * Each structure kind gets a rectangular (or composite) FOOTPRINT several
 * times larger than the old regular-polygon silhouette, drawn with the same
 * vocabulary as the original warehouse/city base sheets: three flat tones, a
 * rim, functional detail (panel grids, container ribs, cell rows, windows) and
 * point lights. Pure + deterministic (no Pixi): returns rect/light ops in
 * LOCAL pixi space centred on the structure, so one plan feeds the in-game
 * renderer (a retained Graphics per structure) and the offline design sheet.
 *
 * Footprints come from the structure catalogue (collider + placement + LOS).
 */
import { getStructureKind, isStructureKindId } from '../../../shared-types/structureKinds.js';
import { PAD_SPECS, padPostCenters } from '../../../shared-types/teleport.js';
import { mixColor, type PolyOp, type Pts } from './structureStyleKit.js';
import { structureStyleDrawer } from './structureStyles.js';
import { drawTerritoryLock } from './territoryLockLook.js';
import {
  box, DECK, gatePost, GLASS, gunBattery, hash, hazard, RED, shieldSpan, slab, STEEL, STEEL_DARK, STEEL_LIGHT, WARM,
  type LightOp, type RectOp,
} from './structureVisualPaint.js';

export { mixColor, type LightOp, type PolyOp, type RectOp };

/**
 * Livery (structure restyle 1c, on by default, `?structLivery=0` = off): where the OWNER's emblem
 * goes (pixi space, centre + radius). `screen`: a big lit sigil screen (the
 * capital, i.e. the beacon); else the emblem is painted flat in the owner's
 * colour. The forge stamps the owner's procedural sigil here (`sigil.ts`
 * `stampSigilSlot`); a future PNG sigil replaces only the emblem drawn into
 * the slot (`slotEmblem`), never the slot itself.
 */
export interface SigilSlotOp { x: number; y: number; r: number; screen?: boolean }
/** Livery: an area painted in the owner's colour (pixi space): the box, or
 *  the polygon `pts` inside it (structure styles). */
export interface LiveryBandOp { x: number; y: number; w: number; h: number; pts?: Pts }

export interface StructureFootprint {
  /** Full width / height (u). */
  w: number;
  h: number;
}

/** Gate / airlock shield state for the draw plan (from room state at runtime). */
export type GateState = 'closed' | 'open' | 'openA' | 'openB';

export interface StructureVisual {
  rects: RectOp[];
  lights: LightOp[];
  footprint: StructureFootprint;
  /** Owner emblem slots (only with `opts.livery`; absent otherwise). */
  sigils?: SigilSlotOp[];
  /** Owner-colour areas (only with `opts.livery`; absent otherwise). */
  bands?: LiveryBandOp[];
  /** Faceted polygons (only for a `?restyle=` style; absent otherwise),
   *  baked before `rects`. */
  polys?: PolyOp[];
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
  /** Gates in game: leave the legacy plan's shield spans out (the design
   *  sheet still draws them). In game the doors are solid rig leaves. */
  omitSpans?: boolean;
  /** Owner livery (on by default, `?structLivery=0` = off): add the sigil slots
   *  and livery bands. Off = the plan is exactly today's. */
  livery?: boolean;
  /** Structure style (`?restyle=`, `structureStyles.ts`); absent or
   *  `current` = today's plan, exactly. */
  style?: string;
  /** Lit deck spike: a road's local arm mask for its style drawer (`StyleCtx.arms`). */
  arms?: number;
}

export function buildStructureVisual(kindId: string, opts: StructureVisualOpts): StructureVisual {
  // Catalogue kinds use the catalogue footprint (the collider's source).
  const fp = opts.size
    ?? (isStructureKindId(kindId) ? getStructureKind(kindId).footprint : { w: 80, h: 80 });
  const rects: RectOp[] = [];
  const lights: LightOp[] = [];
  const W = fp.w, H = fp.h, x0 = -W / 2, y0 = -H / 2;
  const accent = opts.accent;
  const seed = opts.seed ?? 1;
  const live = opts.powered !== false;
  const lit = (x: number, y: number, r: number, c: number): void => {
    if (live) lights.push({ x, y, r, color: c });
  };
  const livery = opts.livery === true;
  const sigils: SigilSlotOp[] = [];
  const bands: LiveryBandOp[] = [];

  // A `?restyle=` style draws this kind (else: today's art below).
  const drawStyle = structureStyleDrawer(opts.style, kindId);
  if (drawStyle) {
    const polys: PolyOp[] = [];
    drawStyle({ kindId, styleId: opts.style!, W, H, accent, seed, live, livery, polys, sigils, bands, lit, ...(opts.arms !== undefined ? { arms: opts.arms } : {}) });
    if (opts.built === false) for (const p of polys) p.alpha = (p.alpha ?? 1) * 0.45;
    return livery ? { rects, lights, footprint: fp, sigils, bands, polys } : { rects, lights, footprint: fp, polys };
  }

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
      if (livery) {
        // The beacon: a big sigil screen over the core (it replaces the core
        // lamp, whose glow would wash the emblem out), and owner-colour bands
        // down the four connecting halls.
        sigils.push({ x: 0, y: 0, r: (c - 60) / 2 - 8, screen: true });
        bands.push({ x: x0 + wing + 6, y: y0 + 70, w: W - 2 * wing - 12, h: 10 });
        bands.push({ x: x0 + wing + 6, y: y0 + H - 80, w: W - 2 * wing - 12, h: 10 });
        bands.push({ x: x0 + 70, y: y0 + wing + 6, w: 10, h: H - 2 * wing - 12 });
        bands.push({ x: x0 + W - 80, y: y0 + wing + 6, w: 10, h: H - 2 * wing - 12 });
      } else {
        lit(0, 0, 26, accent);
      }
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
      // Livery: the emblem on the middle container's roof.
      if (livery) sigils.push({ x: x0 + 14 + (cw + 10) + cw / 2, y: y0 + 14 + (ch + 9) + ch / 2, r: ch / 2 - 6 });
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
      // Livery: the emblem on the cracking column, an owner band at its head.
      if (livery) {
        sigils.push({ x: x0 + W - 70, y: 0, r: 30 });
        bands.push({ x: x0 + W - 104, y: y0 + 26, w: 68, h: 10 });
      }
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
      // Livery: the emblem between the middle cranes, an owner band along
      // the berth edge of the pier block.
      if (livery) {
        sigils.push({ x: x0 + 30 + 90 * 2 + 70, y: y0 + H * 0.225, r: Math.min(24, H * 0.225 - 10) });
        bands.push({ x: x0 + 8, y: y0 + H * 0.45 - 16, w: W - 16, h: 8 });
      }
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
    case 'reactor': {
      // Containment dome on a shielded pad, with coolant towers at the corners.
      box(rects, x0, y0, W, H, DECK, 0.95);
      hazard(rects, x0, y0, W, H);
      for (const [cx, cy] of [[x0 + 20, y0 + 20], [x0 + W - 100, y0 + 20], [x0 + 20, y0 + H - 100], [x0 + W - 100, y0 + H - 100]] as const) {
        slab(rects, cx, cy, 80, 80, STEEL, 8);
      }
      slab(rects, -130, -130, 260, 260, STEEL_DARK, 12);
      box(rects, -80, -80, 160, 160, live ? mixColor(accent, 0xffffff, 0.15) : 0x553322, 0.95);
      lit(0, 0, 30, live ? accent : 0x553322);
      break;
    }
    case 'battery_bank': {
      // A big cell bank: a 6×6 grid of cells with charge bars.
      slab(rects, x0, y0, W, H, STEEL_DARK, 10);
      const cell = (W - 40) / 6 - 6;
      for (let r = 0; r < 6; r++) {
        for (let k = 0; k < 6; k++) {
          const cx = x0 + 20 + k * (cell + 6), cy = y0 + 20 + r * (cell + 6);
          box(rects, cx, cy, cell, cell, STEEL);
          box(rects, cx + 6, cy + cell - 12, cell - 12, 6, live ? accent : 0x553322, 0.95);
        }
      }
      lit(x0 + W - 14, y0 + 14, 8, live ? 0x7fe0a4 : RED);
      break;
    }
    case 'shipyard': {
      // A huge slipway: a long dry dock with a hull frame on the slip, a crane
      // gantry across it and launch lights at the bow end.
      box(rects, x0, y0, W, H, DECK, 0.95);
      slab(rects, x0 + 30, -H / 4, W - 60, H / 2, STEEL_DARK, 12);
      box(rects, x0 + 80, -H / 8, W - 220, H / 4, mixColor(accent, STEEL, 0.5), 0.9);
      for (let x = x0 + 120; x < x0 + W - 140; x += 120) box(rects, x, y0 + 20, 24, H - 40, STEEL_LIGHT, 0.9);
      for (let x = x0 + 60; x < x0 + W - 60; x += 90) box(rects, x, y0 + 26, 40, 22, mixColor(GLASS, STEEL_DARK, 0.6), 0.85);
      lit(x0 + W - 50, -H / 6, 10, live ? accent : 0x553322);
      lit(x0 + W - 50, H / 6, 10, live ? accent : 0x553322);
      lit(x0 + 24, y0 + 24, 10, RED);
      lit(x0 + W - 24, y0 + H - 24, 10, RED);
      break;
    }
    case 'habitat_module': {
      // Housing block: two rows of apartments with lit windows, a roof garden.
      slab(rects, x0, y0, W, H, STEEL_DARK, 12);
      for (const by of [y0 + 18, 12]) {
        slab(rects, x0 + 18, by, W - 36, H / 2 - 30, mixColor(accent, STEEL, 0.55), 6);
        for (let x = x0 + 34; x < x0 + W - 44; x += 36) {
          box(rects, x, by + 14, 18, 14, live ? WARM : mixColor(GLASS, STEEL_DARK, 0.7), 0.9);
          box(rects, x, by + H / 2 - 60, 18, 14, live ? mixColor(WARM, GLASS, 0.4) : mixColor(GLASS, STEEL_DARK, 0.7), 0.9);
        }
      }
      box(rects, -40, -8, 80, 16, mixColor(0x5fae5a, STEEL_DARK, 0.3), 0.95);
      lit(x0 + 22, y0 + 22, 8, RED);
      lit(x0 + W - 22, y0 + H - 22, 8, RED);
      break;
    }
    case 'mine_layer': {
      // Mine layer: an armoured launcher with a rack of mine canisters round a
      // central chute.
      slab(rects, x0, y0, W, H, STEEL_DARK, 12);
      slab(rects, x0 + 22, y0 + 22, W - 44, H - 44, mixColor(accent, STEEL, 0.55), 8);
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3;
        box(rects, Math.cos(a) * (W / 2 - 46) - 13, Math.sin(a) * (H / 2 - 46) - 13, 26, 26, mixColor(accent, STEEL_DARK, 0.35), 0.95);
      }
      box(rects, -22, -22, 44, 44, STEEL_LIGHT);
      lit(0, 0, 10, live ? accent : 0x553322);
      break;
    }
    case 'teleporter':
    case 'teleporter_large':
    case 'pocket_pad':
    case 'alien_gate': {
      // Teleporter (v4 T1): an open pad ringed by its posts. The pad is a
      // faint disc with concentric guide rings; ships hover over it. The posts
      // are the only solid parts (they match the collider).
      const big = kindId === 'teleporter_large' || kindId === 'alien_gate';
      // W1b — a transit pad needs no grid either: its posts are always lit.
      const free = kindId === 'alien_gate' || kindId === 'pocket_pad';
      // v4 A — the Ancients' gate: the same pad, with glowing monolith posts
      // that are always lit (it needs no grid) and a bright centre glyph.
      const alien = kindId === 'alien_gate';
      const post = PAD_SPECS[kindId].post;
      const pad = PAD_SPECS[kindId].padRadius;
      // Faint guide squares on the open pad (decoration only, not solid).
      for (let ring = 0; ring < 3; ring++) {
        const rr = pad * (1 - ring * 0.3);
        box(rects, -rr, -rr, rr * 2, rr * 2, mixColor(accent, STEEL_DARK, 0.82 - ring * 0.08), 0.35);
      }
      for (const [cx, cy] of padPostCenters(kindId)) {
        slab(rects, cx - post / 2, cy - post / 2, post, post, alien ? mixColor(accent, STEEL_DARK, 0.7) : STEEL_DARK, post * 0.25);
        box(rects, cx - post / 4, cy - post / 4, post / 2, post / 2, mixColor(accent, STEEL_LIGHT, alien ? 0.15 : 0.4), 0.95);
        lit(cx, cy, alien ? post / 5 : post / 8, live || free ? accent : 0x553322);
      }
      if (alien) {
        box(rects, -90, -90, 180, 180, mixColor(accent, STEEL_DARK, 0.5), 0.6);
        box(rects, -45, -45, 90, 90, accent, 0.8);
      }
      lit(0, 0, alien ? 60 : big ? 40 : 18, live || free ? accent : 0x553322);
      break;
    }
    case 'tower_module': {
      // Residential tower seen from above: stepped tiers to a lit crown.
      slab(rects, x0, y0, W, H, STEEL_DARK, 14);
      slab(rects, x0 + 26, y0 + 26, W - 52, H - 52, mixColor(accent, STEEL, 0.5), 10);
      slab(rects, x0 + 56, y0 + 56, W - 112, H - 112, mixColor(accent, STEEL_LIGHT, 0.35), 8);
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        box(rects, Math.cos(a) * (W / 2 - 40) - 9, Math.sin(a) * (H / 2 - 40) - 9, 18, 18, live ? WARM : 0x553322, 0.9);
      }
      lit(0, 0, 18, live ? accent : 0x553322);
      break;
    }
    case 'storage_vault': {
      // An armoured vault: thick walls, a grid of sealed lockers, a blast door.
      slab(rects, x0, y0, W, H, STEEL_DARK, 16);
      for (let r = 0; r < 3; r++) {
        for (let k = 0; k < 5; k++) {
          slab(rects, x0 + 30 + k * ((W - 60) / 5), y0 + 30 + r * ((H - 90) / 3), (W - 60) / 5 - 10, (H - 90) / 3 - 10, mixColor(accent, STEEL, 0.55), 4);
        }
      }
      box(rects, -50, y0 + H - 50, 100, 34, STEEL_LIGHT);
      lit(0, y0 + H - 33, 8, WARM);
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
    case 'territory_lock':
      // The spire: a broadcast spine, lantern tower and antenna fins (territoryLockLook.ts).
      drawTerritoryLock({
        box: (x, y, w, h, c, a) => box(rects, x, y, w, h, c, a),
        slab: (x, y, w, h, c, r) => slab(rects, x, y, w, h, c, r),
        lit, mix: mixColor,
      }, W, H, accent, live, { steel: STEEL, dark: STEEL_DARK, light: STEEL_LIGHT, deck: DECK, red: RED });
      break;
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
    // Coastal defences — gun batteries (the guns themselves are mount art).
    case 'aa_quad_40mm':
      gunBattery(rects, 'tub', x0, y0, W, H, W * 0.24, 0, accent, seed);
      lit(x0 + 10, y0 + 10, 4, RED);
      break;
    case 'dp_mount_5in':
      gunBattery(rects, 'pad', x0, y0, W, H, W * 0.3, 0, accent, seed);
      lit(x0 + 14, y0 + 14, 5, RED);
      break;
    case 'coastal_casemate_8in':
      gunBattery(rects, 'casemate', x0, y0, W, H, H * 0.22, W * 0.6, accent, seed);
      lit(x0 + 16, y0 + H - 16, 6, RED);
      break;
    case 'coastal_turret_11in':
      gunBattery(rects, 'pad', x0, y0, W, H, W * 0.3, 0, accent, seed);
      lit(x0 + 18, y0 + 18, 6, RED);
      lit(x0 + W - 18, y0 + H - 18, 6, RED);
      break;
    case 'coastal_barbette_16in':
      gunBattery(rects, 'casemate', x0, y0, W, H, H * 0.24, W * 0.72, accent, seed);
      lit(x0 + 20, y0 + H - 20, 7, RED);
      lit(x0 + W - 20, y0 + H - 20, 7, RED);
      break;
    case 'coastal_lindemann':
      gunBattery(rects, 'casemate', x0, y0, W, H, H * 0.2, W * 0.6, accent, seed);
      lit(x0 + 24, y0 + H - 24, 8, RED);
      lit(x0 + W - 24, y0 + H - 24, 8, RED);
      break;
    case 'siege_gun_80cm':
      gunBattery(rects, 'rail', x0, y0, W, H, W * 0.22, 0, accent, seed);
      lit(0, y0 + H * 0.15, 8, RED);
      break;
    default:
      slab(rects, x0, y0, W, H, mixColor(STEEL, accent, 0.25), 6);
  }
  if (opts.built === false) for (const r of rects) r.alpha *= 0.45;
  return livery ? { rects, lights, footprint: fp, sigils, bands } : { rects, lights, footprint: fp };
}
