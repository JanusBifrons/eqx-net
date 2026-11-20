/**
 * Style C fences family, part 2: the shield gate and the shield airlock as
 * GATEHOUSES (owner-approved look 2026-11-19): squat armoured towers in dark
 * machined metal with worn blue trim and emitter glow, a pocket slot in each
 * tower the door leaves slide into, solid doors, and a red / green deck light
 * strip across the opening. Split out of `structureStyleC.fences.ts` (which
 * lists these drawers in its `kinds` and the leaf art in its `rigs`).
 *
 * The doors are NOT baked here: they are the physical slide leaves of the
 * `gate-doors` / `airlock-doors` rigs (core/articulation/rigs/fences.ts),
 * drawn by the rig view from `doorLeafContext` below. The baked towers leave
 * the opening clear (only the flat deck sill, the leaf track and the deck
 * lights lie in it), so an open door is a clear gap.
 */
import { GraphicsContext } from 'pixi.js';
import {
  LAMP_AMBER, LAMP_WHITE, RIVET, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, DECK, centroid, clipHalf, core, glow, lamp,
  mixColor, ngon, outlinePx, poly, rivets, stencil, wornStripe, type Pt, type Pts, type StyleCtx,
} from './structureStyleKit.js';
import type { Rig } from '../../../core/articulation/rig.js';
import {
  AIRLOCK_END_Y, AIRLOCK_H, AIRLOCK_OPENING, AIRLOCK_POST_D, AIRLOCK_W, GATE_DEPTH, GATE_OPENING, GATE_W,
} from '../../../shared-types/structureKinds/gatePosts.js';
import { DOOR_LEAF_THICKNESS } from '../../../core/articulation/rigs/fences.js';

/** Shield-wall emitter colour (lit, powered) and its dead glass (dark). */
export const EMIT = 0x6fe2f0;
export const EMIT_DEAD = 0x16262a;

// ── Deck light ───────────────────────────────────────────────────────────────

/** Deck light colours: red = shut (or moving), green = fully open; dark glass
 *  when unpowered. */
export const DECK_LIGHT_SHUT = 0xff3a2e;
export const DECK_LIGHT_OPEN = 0x4dff7a;
export const DECK_LIGHT_DEAD = 0x2a1414;

/** The deck light's colour: green only when the door is fully open. Pure, so
 *  the slice that reads the door state off the wire (e.g. a `BodyStatusHook`
 *  drawing over the baked strip) picks the colour the same way. */
export function deckLightColor(open: boolean, live = true): number {
  if (!live) return DECK_LIGHT_DEAD;
  return open ? DECK_LIGHT_OPEN : DECK_LIGHT_SHUT;
}

/** A deck light strip, Pixi frame (y down), centred on the structure. */
export interface DeckLightStrip { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }

/** Strip depth (along the travel axis) and its gap from the door line. */
const DECK_LIGHT_D = 5;
const DECK_LIGHT_GAP = DOOR_LEAF_THICKNESS / 2 + 7;

function stripsAt(cy: number, half: number): DeckLightStrip[] {
  const x0 = -half + 6, x1 = half - 6;
  return [
    { x0, x1, y0: cy - DECK_LIGHT_GAP - DECK_LIGHT_D, y1: cy - DECK_LIGHT_GAP },
    { x0, x1, y0: cy + DECK_LIGHT_GAP, y1: cy + DECK_LIGHT_GAP + DECK_LIGHT_D },
  ];
}

const GATE_STRIPS = Object.freeze(stripsAt(0, GATE_OPENING / 2));
/** Airlock: end A (local +y = Pixi −y) first, then end B. */
const AIRLOCK_STRIPS = Object.freeze([...stripsAt(-AIRLOCK_END_Y, AIRLOCK_OPENING / 2), ...stripsAt(AIRLOCK_END_Y, AIRLOCK_OPENING / 2)]);

/** The deck light strips across a gate's opening (two per door, one either
 *  side of the leaves, so they show while the door is shut). Airlock: A end's
 *  pair, then B end's. Empty for other kinds. */
export function deckLightStrips(kind: string): readonly DeckLightStrip[] {
  return kind === 'shield_gate' ? GATE_STRIPS : kind === 'shield_airlock' ? AIRLOCK_STRIPS : [];
}

/** Bake the deck lights in their state (`open`): today always shut (red). */
function deckLights(c: StyleCtx, open = false): void {
  const col = deckLightColor(open, c.live);
  for (const s of deckLightStrips(c.kindId)) {
    glow(c, [[s.x0, s.y0], [s.x1, s.y0], [s.x1, s.y1], [s.x0, s.y1]], col, 0.95);
  }
}

// ── Towers ───────────────────────────────────────────────────────────────────

/** A box (x0, y0)-(x1, y1) with its corners cut [top-left, top-right,
 *  bottom-right, bottom-left] (0 = square). */
function cutBox(x0: number, y0: number, x1: number, y1: number, cut: readonly [number, number, number, number]): Pt[] {
  const [tl, tr, br, bl] = cut;
  const pts: Pt[] = [];
  pts.push([x0 + tl, y0], [x1 - tr, y0]);
  if (tr > 0) pts.push([x1, y0 + tr]);
  pts.push([x1, y1 - br]);
  if (br > 0) pts.push([x1 - br, y1]);
  pts.push([x0 + bl, y1]);
  if (bl > 0) pts.push([x0, y1 - bl]);
  if (tl > 0) pts.push([x0, y0 + tl]);
  return pts;
}

/** `pts` clipped to the kind's (convex, style C) outline, `m` units inside
 *  it: a tower block meets the outline's corner cuts flush. */
function inOutline(c: StyleCtx, pts: Pts, m = 0.5): Pt[] {
  const out = outlinePx(c.kindId, c.styleId);
  const [cx, cy] = centroid(out);
  let p: Pt[] = [...pts];
  for (let i = 0; i < out.length && p.length >= 3; i++) {
    const a = out[i]!, b = out[(i + 1) % out.length]!;
    const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1;
    let nx = ey / L, ny = -ex / L;
    if (nx * (cx - a[0]) + ny * (cy - a[1]) > 0) { nx = -nx; ny = -ny; }
    p = clipHalf(p, nx, ny, nx * a[0] + ny * a[1] - m);
  }
  return p;
}

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** The flat deck sill across an opening (lift 0: it reads as floor, not
 *  wall) with the leaf track down its door line(s). */
function sill(c: StyleCtx, half: number, y0: number, y1: number, doorYs: readonly number[]): void {
  poly(c, rect(-half, y0, half, y1), DECK, 'metal', 0, 0.5, { seams: 24, seamAngle: 0 });
  for (const dy of doorYs) {
    poly(c, rect(-half, dy - DOOR_LEAF_THICKNESS / 2 - 2, half, dy + DOOR_LEAF_THICKNESS / 2 + 2), SOOT, 'mark', 0, 0.3);
  }
}

/**
 * One gatehouse tower block: a chamfered armoured core with a worn trim band,
 * the door pocket (a dark slot with machined lips) the leaf slides into, the
 * shield projectors on the face that meets the opening, and an emitter lens.
 * `inner` is the x of the face on the opening, `outer` the far face (either
 * order); `doorY` the leaf's centre line; `pocket` the slot length; `ey` the
 * emitter's y.
 */
function tower(
  c: StyleCtx, inner: number, outer: number, y0: number, y1: number,
  doorY: number, pocket: number, ey: number, er: number, salt: number,
): void {
  const s = Math.sign(outer - inner);
  const x0 = Math.min(inner, outer), x1 = Math.max(inner, outer);
  const emit = c.live ? EMIT : EMIT_DEAD;
  const body = core(c, inOutline(c, cutBox(x0, y0, x1, y1, [3, 3, 3, 3]), 0.5), SLAB, 22, Math.PI / 2);
  wornStripe(c, body, 0, outer - s * 14, 8, salt);
  // Armour caps on the top face, either side of the pocket.
  const lip = DOOR_LEAF_THICKNESS / 2 + 4;
  for (const [a, b] of [[y0 + 6, doorY - lip - 3], [doorY + lip + 3, y1 - 6]] as const) {
    if (b - a < 6) continue;
    const ax = s > 0 ? inner + 6 : outer + 22, bx = s > 0 ? outer - 22 : inner - 6;
    poly(c, inOutline(c, cutBox(ax, a, bx, b, [3, 3, 3, 3]), 3), SLAB_LIGHT, 'metal', 4, 1.2, { seams: 14, seamAngle: 0 });
    rivets(c, [ax + 5, (a + b) / 2], [bx - 5, (a + b) / 2], 12, 1.6);
  }
  // The door pocket: a dark slot from the inner face, machined lips each side.
  const px0 = s > 0 ? inner : inner - pocket - 2, px1 = s > 0 ? inner + pocket + 2 : inner;
  poly(c, inOutline(c, rect(px0, doorY - DOOR_LEAF_THICKNESS / 2 - 1.5, px1, doorY + DOOR_LEAF_THICKNESS / 2 + 1.5), 1.5), SOOT, 'metal', -3, 1.5);
  for (const sy of [-1, 1]) {
    const ly = doorY + sy * (DOOR_LEAF_THICKNESS / 2 + 3);
    poly(c, inOutline(c, rect(px0, ly - 1.5, px1, ly + 1.5), 1.5), mixColor(SLAB_LIGHT, 0xffffff, 0.25), 'metal', 2, 0.6);
  }
  // Shield projectors on the opening face, above and below the pocket.
  for (const [a, b] of [[y0 + 7, doorY - lip - 2], [doorY + lip + 2, y1 - 7]] as const) {
    if (b - a < 5) continue;
    const fx0 = s > 0 ? inner + 1 : inner - 6, fx1 = s > 0 ? inner + 6 : inner - 1;
    poly(c, rect(fx0 - s, a - 1, fx1 - s, b + 1), SLAB_DARK, 'metal', 6, 0.8);
    glow(c, rect(fx0, a, fx1, b), emit, 0.9);
  }
  // The emitter lens past the pocket's end, in a bolted collar.
  const ex = outer - s * (er + 6);
  poly(c, ngon(ex, ey, er, 12), SLAB_DARK, 'metal', 26, 1.5);
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    poly(c, ngon(ex + Math.cos(a) * er * 0.8, ey + Math.sin(a) * er * 0.8, 1.2, 6), RIVET, 'metal', 28, 0.4);
  }
  glow(c, ngon(ex, ey, er * 0.55, 12), emit, 0.95);
  c.lit(ex, ey, er * 0.36, c.live ? 0xd8fbff : EMIT_DEAD);
}

/** Shield gate (416 × 72): two 120-wide gatehouse towers round the 176
 *  opening. Each tower takes its leaf into a pocket through its middle; the
 *  opening holds only the deck sill, the leaf track and the deck lights. */
export function shieldGate(c: StyleCtx): void {
  const half = GATE_W / 2, hd = GATE_DEPTH / 2, gap = GATE_OPENING / 2;
  sill(c, gap, -hd + 4, hd - 4, [0]);
  for (const sx of [-1, 1] as const) {
    tower(c, sx * gap, sx * half, -hd, hd, 0, gap, 0, 11, sx > 0 ? 11 : 13);
    lamp(c, sx * (half - 10), hd - 9, 2.5, sx > 0 ? LAMP_AMBER : LAMP_WHITE);
  }
  deckLights(c);
  if (c.livery) c.sigils.push({ x: half - 54, y: 20, r: 9 });
}

/** Shield airlock (392 × 260): a gatehouse tower at each corner (100 × 64,
 *  a leaf pocket through each) joined by armoured side walls down the
 *  chamber; the chamber floor, the end sills and the deck lights lie flat in
 *  the 192 opening. */
export function shieldAirlock(c: StyleCtx): void {
  const half = AIRLOCK_W / 2, hh = AIRLOCK_H / 2, gap = AIRLOCK_OPENING / 2;
  const wall = 40, inEnd = AIRLOCK_END_Y - AIRLOCK_POST_D / 2; // the towers' inner (chamber) face
  // Chamber floor and the end sills: one flat deck down the opening, and the
  // chamber's wider floor between the walls.
  sill(c, gap, -hh + 3, hh - 3, [-AIRLOCK_END_Y, AIRLOCK_END_Y]);
  poly(c, rect(-half + wall, -inEnd, half - wall, inEnd), DECK, 'metal', 0, 0.5, { seams: 24, seamAngle: 0 });
  // Travel arrows down the chamber centre (floor paint).
  for (const y of [-34, 0, 34]) poly(c, [[-10, y + 6], [0, y - 4], [10, y + 6], [10, y + 10], [0, y], [-10, y + 10]], mixColor(0xb9b4a2, DECK, 0.45), 'mark', 0, 0.3);
  // Side walls between the towers: dark armour with a blue trim band.
  for (const sx of [-1, 1] as const) {
    const x0 = sx > 0 ? half - wall : -half, x1 = sx > 0 ? half : -half + wall;
    const w = core(c, rect(x0, -inEnd - 2, x1, inEnd + 2), SLAB_DARK, 16, 0);
    wornStripe(c, w, Math.PI / 2, sx * (half - wall / 2), 7, sx > 0 ? 21 : 23);
    rivets(c, [(x0 + x1) / 2 - 12, -inEnd + 8], [(x0 + x1) / 2 - 12, inEnd - 8], 14, 1.6);
    poly(c, rect(sx > 0 ? x0 - 3 : x1, -inEnd + 6, sx > 0 ? x0 : x1 + 3, inEnd - 6), mixColor(c.accent, SLAB_DARK, 0.55), 'paint', 1, 0.5);
  }
  // The four corner towers (A end at Pixi −y, B end at +y).
  for (const sy of [-1, 1] as const) {
    const y0 = sy > 0 ? inEnd : -hh, y1 = sy > 0 ? hh : -inEnd;
    const doorY = sy * AIRLOCK_END_Y;
    for (const sx of [-1, 1] as const) {
      tower(c, sx * gap, sx * half, y0, y1, doorY, gap, sy * (inEnd + 8.5), 7, 31 + sx + 2 * sy);
    }
    lamp(c, 0, sy * (hh - 6), 2.5, LAMP_AMBER);
  }
  deckLights(c);
  stencil(c, '02', -half + 18, -6, 12);
  if (c.livery) c.sigils.push({ x: half - wall / 2, y: 0, r: 12 });
}

// ── Door leaves (rig part art) ───────────────────────────────────────────────

/** Leaf palette: gunmetal armour a shade lighter than the towers (so a shut
 *  door reads against them), blue trim, hazard meeting edge. */
const LEAF_FILL = 0x353a40;
const LEAF_PLATE = 0x454b52;
const LEAF_EDGE = 0x0a0c0e;
const LEAF_RIB = 0x23272b;
const LEAF_LIP = 0x98a5b1;
const LEAF_RIVET = 0xa3acb5;
const LEAF_TRIM = 0x3f6f9e;
const LEAF_HAZARD = 0xd9a92a;

const leafContexts = new Map<string, GraphicsContext | null>();

/**
 * The shared art of a gate / airlock door leaf (rig part `i`): a heavy
 * armoured slide door in the leaf's own Pixi frame, centred on its anchor.
 * A dark frame round a raised armour plate with cross ribs, a blue trim
 * line down both long faces, rivets, and on the meeting edge (the end facing
 * against the slide) a hazard band behind a black seam with a bright lip.
 * Null for a part that is not a slide leaf (the role art draws it).
 */
export function doorLeafContext(rig: Rig, i: number): GraphicsContext | null {
  const part = rig.parts[i]!;
  const key = `${rig.id}/${part.id}`;
  const hit = leafContexts.get(key);
  if (hit !== undefined) return hit;
  const o = part.outline;
  let g: GraphicsContext | null = null;
  if (part.joint.type === 'slide' && o !== undefined && o.length >= 6) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let j = 0; j < o.length; j += 2) {
      x0 = Math.min(x0, o[j]!); x1 = Math.max(x1, o[j]!);
      y0 = Math.min(y0, -o[j + 1]!); y1 = Math.max(y1, -o[j + 1]!);
    }
    // The meeting edge faces against the slide (slide axis +x: the left end).
    const meetLeft = (part.joint.axisX ?? 1) > 0;
    g = new GraphicsContext();
    const w = x1 - x0, h = y1 - y0;
    g.rect(x0, y0, w, h).fill({ color: LEAF_FILL });
    // Raised armour plate, cross ribs over it.
    const band = 8;
    const px0 = meetLeft ? x0 + band + 2 : x0 + 4, px1 = meetLeft ? x1 - 4 : x1 - band - 2;
    g.poly([px0 + 2, y0 + 3, px1 - 2, y0 + 3, px1, y0 + 5, px1, y1 - 5, px1 - 2, y1 - 3, px0 + 2, y1 - 3, px0, y1 - 5, px0, y0 + 5], true)
      .fill({ color: LEAF_PLATE }).stroke({ color: LEAF_EDGE, width: 1.2 });
    for (let x = px0 + 12; x < px1 - 6; x += 14) {
      g.moveTo(x, y0 + 4).lineTo(x, y1 - 4).stroke({ color: LEAF_RIB, width: 2.4 });
      g.moveTo(x + 1.6, y0 + 4).lineTo(x + 1.6, y1 - 4).stroke({ color: LEAF_LIP, width: 0.8, alpha: 0.5 });
    }
    // Blue trim down both long faces.
    for (const ty of [y0 + 1.6, y1 - 1.6]) g.moveTo(x0 + 2, ty).lineTo(x1 - 2, ty).stroke({ color: LEAF_TRIM, width: 1.6 });
    // Hazard band on the meeting edge: yellow, black diagonals.
    const hx0 = meetLeft ? x0 : x1 - band, hx1 = hx0 + band;
    g.rect(hx0, y0, band, h).fill({ color: LEAF_HAZARD });
    for (let y = y0 - band; y < y1; y += 6) {
      g.poly([hx0, y, hx1, y + band, hx1, y + band + 3, hx0, y + 3], true).fill({ color: LEAF_EDGE, alpha: 0.85 });
    }
    // Repaint the frame edges the stripes overran, then the meeting seam.
    g.rect(x0, y0, w, h).stroke({ color: LEAF_EDGE, width: 2.6 });
    const sx = meetLeft ? x0 : x1, lx = meetLeft ? x0 + band + 1 : x1 - band - 1;
    g.moveTo(lx, y0 + 1).lineTo(lx, y1 - 1).stroke({ color: LEAF_LIP, width: 1.6 });
    g.moveTo(sx, y0).lineTo(sx, y1).stroke({ color: LEAF_EDGE, width: 3.2 });
    // Rivets down the long faces.
    for (let x = px0 + 6; x < px1 - 3; x += 14) {
      for (const ry of [y0 + 4.6, y1 - 4.6]) g.circle(x, ry, 1.2).fill({ color: LEAF_RIVET });
    }
  }
  leafContexts.set(key, g);
  return g;
}
