/**
 * Base platforms slice 21 — gates and roads. On a deck room a shield gate
 * stands on a hex seam (`'edge'` deck slot, `deckPlacement.ts`). Roads are
 * optional (owner ruling): a gate needs no road, so placement never checks
 * one. Generated bases still lay a road on the inside hex of each gate
 * (`growDeckFence.ts`); {@link isRoadBesideDeckGate} tells whether a road
 * sits beside a gate's seam (their tests use it).
 *
 * The two hexes of a seam: a gate at the seam's midpoint, turned along the
 * seam (`rotDeg`), has the hex centres one inradius away on its local ±y.
 * Pure, allocation-free.
 */
import { DECK_CORNER_TOLERANCE, DECK_HEX_INRADIUS } from '../hex/deckCorners.js';
import { pixelToAxialInto, type AxialHex } from '../hex/hex.js';
import { DECK_HEX_FLAT, DECK_HEX_SIZE, deckHexCentreInto } from '../hex/plates.js';
import { DECK_FENCE_GATE_KIND } from './deckLinks.js';

/** The road deck tile kind (`structureKinds/deckTiles.ts`). */
export const DECK_ROAD_KIND = 'road';

/** Is a `kind` centred at (sx, sy) a road on one of the two hexes beside the
 *  seam a gate at (gx, gy), turned `rotDeg` along it, stands on? */
export function isRoadBesideDeckGate(kind: string | undefined, sx: number, sy: number, gx: number, gy: number, rotDeg: number): boolean {
  if (kind !== DECK_ROAD_KIND) return false;
  const r = (rotDeg * Math.PI) / 180;
  const nx = -Math.sin(r) * DECK_HEX_INRADIUS, ny = Math.cos(r) * DECK_HEX_INRADIUS;
  const tol = DECK_CORNER_TOLERANCE;
  if (Math.abs(sx - (gx + nx)) <= tol && Math.abs(sy - (gy + ny)) <= tol) return true;
  return Math.abs(sx - (gx - nx)) <= tol && Math.abs(sy - (gy - ny)) <= tol;
}

const ROAD_HEX: AxialHex = { q: 0, r: 0 };
const AT_HEX: AxialHex = { q: 0, r: 0 };

/** "Roads can't go through a connector": does a connector's box (centre
 *  (cx, cy), half extents `hw` × `hh`) reach into the deck hex of the road
 *  centred at (rx, ry)? The road's art paves its whole hex out to the seams
 *  (`structureStyleC.transport.road.ts`), wider than its 800 × 692 footprint,
 *  so a pylon anywhere in that hex would sit under the carriageway. Tests the
 *  box's centre and corners (a connector is far smaller than a hex). Pure,
 *  allocation-free. */
export function connectorOnRoadHex(cx: number, cy: number, hw: number, hh: number, rx: number, ry: number): boolean {
  pixelToAxialInto(rx, ry, DECK_HEX_SIZE, ROAD_HEX);
  for (let k = 0; k < 5; k++) {
    const x = k === 0 ? cx : cx + (k & 1 ? hw : -hw);
    const y = k === 0 ? cy : cy + (k & 2 ? hh : -hh);
    pixelToAxialInto(x, y, DECK_HEX_SIZE, AT_HEX);
    if (AT_HEX.q === ROAD_HEX.q && AT_HEX.r === ROAD_HEX.r) return true;
  }
  return false;
}

// ── Road auto-turn (owner 2026-11-27: roads line up by themselves) ─────────

/** World join bits of a deck hex (`roadJoinBits`): bit `i` (0..5) = a road
 *  in the hex across edge `i` (the edge midpoint at game angle 60°·i); bit
 *  `ROAD_GATE_SHIFT + i` = a shield gate standing on edge `i`'s seam. */
export const ROAD_GATE_SHIFT = 6;

const JOIN_C: { x: number; y: number } = { x: 0, y: 0 };
const JOIN_H: AxialHex = { q: 0, r: 0 };
const JOIN_TOL = DECK_HEX_INRADIUS * 0.05;

/** The edge index (0..5) of a vector at angle 60°·i, or -1 when its length
 *  is not `len` (± JOIN_TOL). */
function edgeOf(vx: number, vy: number, len: number): number {
  if (Math.abs(Math.hypot(vx, vy) - len) > JOIN_TOL) return -1;
  return ((Math.round((Math.atan2(vy, vx) * 180) / Math.PI / 60) % 6) + 6) % 6;
}

/** What ONE structure (`kind` centred at (x, y)) adds to deck hex (q, r)'s
 *  world join bits: a road in a neighbouring hex sets that edge's road bit, a
 *  shield gate on one of the hex's seams sets that edge's gate bit. The ONE
 *  rule both the client ghost and the server's `place_structure` fold over
 *  their structures (invariant 15). Pure, allocation-free. */
export function roadJoinBits(q: number, r: number, kind: string | undefined, x: number, y: number): number {
  const isRoad = kind === DECK_ROAD_KIND;
  if (!isRoad && kind !== DECK_FENCE_GATE_KIND) return 0;
  deckHexCentreInto(q, r, JOIN_C);
  if (!isRoad) {
    const i = edgeOf(x - JOIN_C.x, y - JOIN_C.y, DECK_HEX_INRADIUS);
    return i < 0 ? 0 : 1 << (ROAD_GATE_SHIFT + i);
  }
  pixelToAxialInto(x, y, DECK_HEX_SIZE, JOIN_H);
  const cx = JOIN_C.x, cy = JOIN_C.y;
  deckHexCentreInto(JOIN_H.q, JOIN_H.r, JOIN_C);
  const i = edgeOf(JOIN_C.x - cx, JOIN_C.y - cy, DECK_HEX_FLAT);
  return i < 0 ? 0 : 1 << i;
}

/** A hex's 6-bit edge mask from its join bits: bit `i` set when edge `i`
 *  has a road beyond it OR a gate on it (what a road draws arms to). */
export function roadJoinEdges(joins: number): number {
  return (joins & 63) | ((joins >> ROAD_GATE_SHIFT) & 63);
}

/** The turn (degrees) a road takes with no road or gate beside it. */
export const ROAD_DEFAULT_TURN_DEG = 30;

/** The axis (0..2: edges a and a + 3) with the most bits set in a 6-bit
 *  mask, ties to the lowest; -1 when the mask is empty. */
function bestAxis(mask: number): number {
  let best = -1, bestN = 0;
  for (let a = 0; a < 3; a++) {
    const n = ((mask >> a) & 1) + ((mask >> (a + 3)) & 1);
    if (n > bestN) { bestN = n; best = a; }
  }
  return best;
}

/** A road's automatic turn (degrees, one of 30° + 60°·k) from its hex's
 *  world join bits ({@link roadJoinBits}): its carriageway (local y, game
 *  angle rot ± 90°) runs along the axis with the most neighbouring roads
 *  (continue the road), else the axis of a gate on one of its seams (meet
 *  the gate), else {@link ROAD_DEFAULT_TURN_DEG}. Pure. */
export function roadAutoTurnDeg(joins: number): number {
  let a = bestAxis(joins & 63);
  if (a < 0) a = bestAxis((joins >> ROAD_GATE_SHIFT) & 63);
  if (a < 0) return ROAD_DEFAULT_TURN_DEG;
  return (60 * a + 270) % 360;
}
