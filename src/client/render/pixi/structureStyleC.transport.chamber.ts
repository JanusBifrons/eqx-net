/**
 * Style C transport family, part 2: the teleporter CHAMBER (teleporter
 * redesign T4, the owner's "B Through-pass" mock-up): a plated floor deck the
 * ships sit on, armoured walls along the chamber's wall boxes, chamfered
 * corner towers each carrying a violet charge coil, a floor light ring,
 * entry chevrons at each doorway and a deck light strip either side of each
 * door line. Drawn for the 800 pads (`teleporter`, `pocket_pad`); listed by
 * `structureStyleC.transport.ts` (its `kinds`, `rigs`, `status`).
 *
 * Geometry is never re-derived here: towers are `padPostCenters`, walls are
 * `padChamberWalls` (the collider, T1), the doorway is `padDoorwayHalf`, the
 * door line is the leaf rig's centre line (wall band). Every size detail
 * scales with the tower side (`PAD_SPECS.post`), so the drawer is generic
 * over chamber kinds.
 *
 * The door leaves are NOT baked: they are the `tp-doors` rig's slide leaves,
 * drawn with the gatehouse leaf art (`doorLeafContext`). The baked walls
 * carry the pocket slot each open leaf lies in.
 *
 * Live state rides the existing body-status hook (`BodyStatusHook`, the
 * gatehouse deck light's): the floor lights and chevrons follow the jump
 * phase (`teleport.phase`: green idle / open, amber flashing armed /
 * closing, red sealed), the coils fill with the banked charge
 * (`teleport.chargePct`), and the door strips follow the decoded door
 * segment exactly as the gatehouse's do (`deckEndState`).
 */
import { GraphicsContext } from 'pixi.js';
import {
  DECK, HAZARD, LAMP_AMBER, RIVET, SIGN_GLASS, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, STENCIL, chamferBox, chevron,
  core, glow, lamp, mixColor, ngon, poly, rivets, rng, wornStripe, type Pt, type StyleCtx,
} from './structureStyleKit.js';
import { DECK_END_DARK, DECK_END_OPEN, DECK_LIGHT_DEAD, DECK_LIGHT_OPEN, DECK_LIGHT_SHUT, deckEndState } from './structureStyleC.fences.gate.js';
import { DOOR_LEAF_THICKNESS } from '../../../core/articulation/rigs/fences.js';
import { padChamberWalls } from '../../../core/structures/padChamber.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import type { BodyStatusHook } from './structureSocketNubs.js';
import type { StructureKindId } from '../../../shared-types/structureKinds.js';
import {
  PAD_SPECS, TP_PHASE, isFreeTeleporterKind, isPadChamberKind, padDoorwayHalf, padHalfExtent, padPostCenters,
  type TeleporterKind,
} from '../../../shared-types/teleport.js';

/** Charge-coil violet (the teleporter panel's charge bar colour). */
export const COIL_VIOLET = 0x9b7bff;
/** A coil's unlit track (dim violet glass). */
export const COIL_DIM = mixColor(COIL_VIOLET, SIGN_GLASS, 0.72);
/** Amber of the armed / closing floor lights (bright, and its flash-off). */
export const TP_AMBER = LAMP_AMBER;
export const TP_AMBER_OFF = mixColor(LAMP_AMBER, 0x000000, 0.55);

/** Coil fill steps (the code's charge axis) and coil track segments. */
export const COIL_STEPS = 12;
const COIL_SEGS = 24;
/** Floor light ring segments. */
const RING_SEGS = 36;
/** Armed / closing lights flash: one half-period, in rig clock ticks. */
export const AMBER_FLASH_TICKS = 8;

/** Deck strip depth and gap from the door line (the gatehouse's). */
const STRIP_D = 5;
const STRIP_GAP = DOOR_LEAF_THICKNESS / 2 + 7;

type Flat = number[];
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const flat = (pts: readonly Pt[]): Flat => pts.flatMap(([x, y]) => [x, y]);

/** An annulus segment from angle a0 to a1 (Pixi frame, clockwise from -y). */
function arcSeg(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): Pt[] {
  return [
    [cx + Math.cos(a0) * r1, cy + Math.sin(a0) * r1], [cx + Math.cos(a1) * r1, cy + Math.sin(a1) * r1],
    [cx + Math.cos(a1) * r0, cy + Math.sin(a1) * r0], [cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0],
  ];
}

/** A ring of `n` segments (small gaps between), starting at -y, clockwise. */
function ringSegs(cx: number, cy: number, r0: number, r1: number, n: number, gap: number): Pt[][] {
  const out: Pt[][] = [];
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + (i / n) * Math.PI * 2;
    out.push(arcSeg(cx, cy, r0, r1, a0 + gap, a0 + (Math.PI * 2) / n - gap));
  }
  return out;
}

/** A chamber's drawing geometry, Pixi frame (y down), from the T1 helpers. */
interface ChamberGeom {
  readonly r: number; readonly post: number; readonly h: number; readonly band: number; readonly door: number;
  /** Detail scale: 1 on the 800 pads (tower side 80). */
  readonly k: number;
  readonly towers: readonly Pt[];
  /** Wall boxes [x0, y0, x1, y1]; `side` = a side wall (long along y). */
  readonly walls: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number; side: boolean }>;
  readonly ring: readonly Pt[][];
  readonly chevrons: readonly Pt[][];
  readonly doorStrips: readonly Pt[][];
  readonly wallStrips: readonly Pt[][];
  readonly coils: readonly Pt[][][];
  readonly lens: readonly Pt[];
  readonly halo: readonly Pt[];
}

/** Chevron rows: distance in from the pad edge (× padRadius). */
const CHEVRON_ROWS = [0.06, 0.18, 0.3] as const;

const geoms = new Map<string, ChamberGeom>();

/** The chamber geometry of `kind` (cold: built once per kind). */
export function chamberGeom(kind: TeleporterKind): ChamberGeom {
  const hit = geoms.get(kind);
  if (hit !== undefined) return hit;
  const { padRadius: r, post } = PAD_SPECS[kind];
  const h = padHalfExtent(kind), band = h - post / 2, door = padDoorwayHalf(kind), k = post / 80;
  const towers = padPostCenters(kind).map(([x, y]) => [x, -y] as const);
  const walls = padChamberWalls(kind).map((b) => ({
    x0: b.cx - b.hw, x1: b.cx + b.hw, y0: -b.cy - b.hh, y1: -b.cy + b.hh, side: b.hh > b.hw,
  }));
  const ring = ringSegs(0, 0, r * 0.58, r * 0.62, RING_SEGS, 0.02);
  const chevrons: Pt[][] = [];
  const doorStrips: Pt[][] = [];
  for (const sy of [-1, 1] as const) {
    // Pointing inward: at the Pixi -y end, down (+y), and vice versa.
    for (const f of CHEVRON_ROWS) chevrons.push(chevron(0, sy * r * (1 - f), door * 0.75, r * 0.1, r * 0.035, sy > 0 ? -1 : 1));
    const x0 = -door + 6 * k, x1 = door - 6 * k, dy = sy * band;
    doorStrips.push(rect(x0, dy - STRIP_GAP - STRIP_D, x1, dy - STRIP_GAP), rect(x0, dy + STRIP_GAP, x1, dy + STRIP_GAP + STRIP_D));
  }
  // Status strip down the inner face of each side wall.
  const wallStrips = walls.filter((w) => w.side).map((w) => {
    const s = w.x0 < 0 ? -1 : 1, inner = s < 0 ? w.x1 : w.x0; // the face on the chamber
    const a = inner + s * 10 * k, b = inner + s * 16 * k;
    return rect(Math.min(a, b), w.y0 + 12 * k, Math.max(a, b), w.y1 - 12 * k);
  });
  const coils = towers.map(([x, y]) => ringSegs(x, y, post * 0.22, post * 0.32, COIL_SEGS, 0.03));
  const g: ChamberGeom = {
    r, post, h, band, door, k, towers, walls, ring, chevrons, doorStrips, wallStrips, coils,
    lens: ngon(0, 0, r * 0.09, 24), halo: ngon(0, 0, r * 0.3, 32),
  };
  geoms.set(kind, g);
  return g;
}

// ── The bake ─────────────────────────────────────────────────────────────────

/** Floor plate tones (a shade over the soot deck so ships read on it). */
const FLOOR = mixColor(SLAB_DARK, DECK, 0.35);
const FLOOR_PAINT = mixColor(STENCIL, DECK, 0.55);

/** The plated floor deck: a soot base, then a grid of bevelled plates with
 *  alternating seams; the doorway sills; the hazard threshold. */
function floor(c: StyleCtx, g: ChamberGeom): void {
  const { r, h, door, k } = g;
  poly(c, rect(-r, -r, r, r), DECK, 'metal', 0, 0.5);
  const n = Math.max(4, Math.round((2 * r) / 160)), s = (2 * r) / n, rand = rng(c.seed * 7919 + 41);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const tone = mixColor(FLOOR, DECK, 0.15 + 0.3 * rand());
      poly(c, chamferBox(-r + i * s + 2 * k, -r + j * s + 2 * k, s - 4 * k, s - 4 * k, 6 * k), tone, 'metal', 1.5, 1.5,
        { seams: 20 * k, seamAngle: (i + j) % 2 === 0 ? 0 : Math.PI / 2 });
    }
  }
  for (const sy of [-1, 1] as const) {
    const y0 = sy > 0 ? r : -h, y1 = sy > 0 ? h : -r;
    poly(c, rect(-door, y0, door, y1), DECK, 'metal', 0, 0.5, { seams: 24 * k, seamAngle: 0 });
    const ty = sy * (h - 7 * k);
    poly(c, rect(-door, ty - 4.5 * k, door, ty + 4.5 * k), HAZARD, 'hazard', 1, 0.6);
  }
  // A faint guide circle inside the light ring.
  for (const seg of ringSegs(0, 0, r * 0.4, r * 0.41, 24, 0.04)) poly(c, seg, FLOOR_PAINT, 'mark', 0, 0.3);
}

/** The floor lights, chevrons and strips, baked as dark glass (the live
 *  colours are the status overlay's). */
function lightGlass(c: StyleCtx, g: ChamberGeom): void {
  for (const seg of g.ring) glow(c, seg, SIGN_GLASS, 1);
  for (const ch of g.chevrons) poly(c, ch, FLOOR_PAINT, 'mark', 0, 0.3);
  for (const s of g.doorStrips) glow(c, s, DECK_LIGHT_DEAD, 0.95);
  for (const s of g.wallStrips) glow(c, s, SIGN_GLASS, 1);
}

/** The centre emitter: a dark bolted disc round a violet lens. */
function emitter(c: StyleCtx, g: ChamberGeom): void {
  const R = g.r * 0.17;
  poly(c, ngon(0, 0, R, 24), SLAB_DARK, 'metal', 6, 2);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    poly(c, ngon(Math.cos(a) * R * 0.82, Math.sin(a) * R * 0.82, 1.8 * g.k, 6), RIVET, 'metal', 1, 0.5);
  }
  glow(c, g.lens, c.live ? COIL_DIM : SIGN_GLASS, 1);
}

/** The walls along the wall boxes: dark armour with a worn trim band and
 *  rivets; each doorway stub carries the pocket slot its leaf slides into. */
function walls(c: StyleCtx, g: ChamberGeom): void {
  const { band, k } = g;
  let salt = 61;
  for (const w of g.walls) {
    const body = core(c, chamferBox(w.x0, w.y0, w.x1 - w.x0, w.y1 - w.y0, 3 * k), SLAB_DARK, 22, w.side ? 0 : Math.PI / 2);
    const mx = (w.x0 + w.x1) / 2, my = (w.y0 + w.y1) / 2;
    if (w.side) {
      const outer = w.x0 < 0 ? w.x0 : w.x1, s = Math.sign(outer);
      wornStripe(c, body, 0, outer - s * 14 * k, 8 * k, salt++);
      rivets(c, [mx, w.y0 + 10 * k], [mx, w.y1 - 10 * k], 16 * k, 1.8 * k);
      continue;
    }
    // Doorway stub: the pocket on the leaf line, machined lips each side.
    const dy = my < 0 ? -band : band;
    wornStripe(c, body, Math.PI / 2, my < 0 ? w.y0 + 10 * k : w.y1 - 10 * k, 7 * k, salt++);
    poly(c, rect(w.x0 + 1, dy - DOOR_LEAF_THICKNESS / 2 - 1.5, w.x1 - 1, dy + DOOR_LEAF_THICKNESS / 2 + 1.5), SOOT, 'metal', -3, 1.5);
    for (const sy of [-1, 1]) {
      const ly = dy + sy * (DOOR_LEAF_THICKNESS / 2 + 3);
      poly(c, rect(w.x0 + 1, ly - 1.5, w.x1 - 1, ly + 1.5), mixColor(SLAB_LIGHT, 0xffffff, 0.25), 'metal', 2, 0.6);
    }
    rivets(c, [w.x0 + 8 * k, my < 0 ? w.y1 - 6 * k : w.y0 + 6 * k], [w.x1 - 8 * k, my < 0 ? w.y1 - 6 * k : w.y0 + 6 * k], 14 * k, 1.6 * k);
  }
}

/** The corner towers: chamfered armoured blocks, an armour cap, and the
 *  charge coil in its housing (the coil track baked dim; the overlay fills
 *  it with the charge). */
function towers(c: StyleCtx, g: ChamberGeom): void {
  const { post, k } = g;
  const half = post / 2, cut = post * 0.32;
  for (let i = 0; i < g.towers.length; i++) {
    const [x, y] = g.towers[i]!;
    core(c, chamferBox(x - half, y - half, post, post, cut), SLAB, 34, Math.PI / 4);
    poly(c, chamferBox(x - half + 5 * k, y - half + 5 * k, post - 10 * k, post - 10 * k, cut - 3 * k), SLAB_LIGHT, 'metal', 4, 1.2,
      { seams: 14 * k, seamAngle: 0 });
    poly(c, ngon(x, y, post * 0.37, 16), SLAB_DARK, 'metal', 6, 1.5);
    for (const seg of g.coils[i]!) glow(c, seg, c.live ? COIL_DIM : SIGN_GLASS, 1);
    glow(c, ngon(x, y, post * 0.1, 12), c.live ? COIL_DIM : SIGN_GLASS, 1);
    // A work lamp on the face looking down the side wall.
    lamp(c, x, y + (y < 0 ? half - 6 * k : -half + 6 * k), 3 * k, LAMP_AMBER);
  }
}

/** Teleporter chamber (800 pads; generic over chamber kinds). */
export function chamber(c: StyleCtx): void {
  if (!isPadChamberKind(c.kindId)) return;
  const g = chamberGeom(c.kindId);
  floor(c, g);
  lightGlass(c, g);
  emitter(c, g);
  walls(c, g);
  towers(c, g);
  if (c.livery) for (const s of [-1, 1]) c.sigils.push({ x: s * g.band, y: 0, r: g.post * 0.3 });
}

// ── Live state (BodyStatusHook) ─────────────────────────────────────────────

/** Codes up to here are "no power": lights dark, coils show the charge dim. */
const DARK_CODES = COIL_STEPS + 1;

/** The coil fill step of a charge percentage (full only at 100). */
export function coilStep(chargePct: number): number {
  return Math.floor((Math.max(0, Math.min(100, chargePct)) * COIL_STEPS) / 100);
}

/**
 * Body-state code of a chamber pad: 0 = not built (the bake shows). Unlit
 * (a powered pad with no power; a free pad is always lit): 1 + charge step.
 * Lit: DARK_CODES + 1 + door + 3 * (flash + 2 * (phase + 5 * step)), where
 * door is the gatehouse's deck end state of the decoded door segment at
 * `tick`, flash the armed / closing flash at the rig clock. Alloc-free.
 */
export function chamberCode(kind: StructureKindId, st: StructureRenderState | undefined, tick = 0): number {
  if (st === undefined || !st.built) return 0;
  const t = st.teleport;
  const q = coilStep(t?.chargePct ?? 0);
  const live = isFreeTeleporterKind(kind) || st.powered === true;
  if (!live) return 1 + q;
  const p = t === undefined ? 0 : Math.max(0, Math.min(4, t.phase | 0));
  const flashing = p === TP_PHASE.ARMED || p === TP_PHASE.CLOSING;
  const b = flashing && (Math.floor(tick / AMBER_FLASH_TICKS) & 1) === 1 ? 1 : 0;
  const door = deckEndState(st.doorA, true, tick);
  return DARK_CODES + 1 + door + 3 * (b + 2 * (p + 5 * q));
}

/** The floor light colour of a phase (`flashOff`: the amber flash's off beat). */
export function phaseLightColor(phase: number, flashOff: boolean): number {
  if (phase === TP_PHASE.ARMED || phase === TP_PHASE.CLOSING) return flashOff ? TP_AMBER_OFF : TP_AMBER;
  return phase === TP_PHASE.SEALED ? DECK_LIGHT_SHUT : DECK_LIGHT_OPEN;
}

const _fill = { color: 0, alpha: 1 };

function fillPts(g: GraphicsContext, pts: readonly Pt[], color: number, alpha: number): void {
  _fill.color = color; _fill.alpha = alpha;
  g.poly(flat(pts), true).fill(_fill);
}

/** Draw `code`'s lights over the bake (cold: once per code, shared). */
function drawChamber(g: GraphicsContext, code: number, kind: StructureKindId): void {
  if (code <= 0 || !isPadChamberKind(kind)) return;
  const geo = chamberGeom(kind);
  const lit = code > DARK_CODES;
  let q: number, phase = 0, flashOff = false, door = DECK_END_DARK;
  if (!lit) q = code - 1;
  else {
    let v = code - DARK_CODES - 1;
    door = v % 3; v = Math.floor(v / 3);
    flashOff = v % 2 === 1; v = Math.floor(v / 2);
    phase = v % 5; q = Math.floor(v / 5);
  }
  const col = lit ? phaseLightColor(phase, flashOff) : DECK_LIGHT_DEAD;
  const idle = phase === TP_PHASE.IDLE || phase === TP_PHASE.OPEN;
  for (const seg of geo.ring) fillPts(g, seg, col, lit ? (idle ? 0.6 : 0.95) : 1);
  for (const ch of geo.chevrons) fillPts(g, ch, col, lit ? 0.9 : 0.6);
  for (const s of geo.wallStrips) fillPts(g, s, col, lit ? 0.85 : 1);
  // Door strips: the gatehouse's rule (green only fully open, red shut or moving).
  const doorCol = !lit || door === DECK_END_DARK ? DECK_LIGHT_DEAD : door === DECK_END_OPEN ? DECK_LIGHT_OPEN : DECK_LIGHT_SHUT;
  for (const s of geo.doorStrips) fillPts(g, s, doorCol, 0.95);
  // Coils: fill clockwise from the top with the banked charge.
  const segs = Math.round((q * COIL_SEGS) / COIL_STEPS);
  const hot = lit && phase === TP_PHASE.SEALED;
  for (const coil of geo.coils) {
    for (let i = 0; i < segs; i++) fillPts(g, coil[i]!, lit ? COIL_VIOLET : COIL_DIM, lit ? 0.95 : 0.8);
  }
  if (hot) {
    for (const [x, y] of geo.towers) fillPts(g, ngon(x, y, geo.post * 0.45, 16), COIL_VIOLET, 0.22);
    fillPts(g, geo.halo, COIL_VIOLET, 0.18);
  }
  if (lit) fillPts(g, geo.lens, COIL_VIOLET, hot ? 1 : 0.35 + (0.6 * q) / COIL_STEPS);
}

/** The chamber's live lights (`BodyStatusHook`, the socket-nub overlay). */
export const chamberStatus: BodyStatusHook = { code: chamberCode, draw: drawChamber };
