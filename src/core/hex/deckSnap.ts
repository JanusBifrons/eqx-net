/**
 * Base-platform deck slots (pure, blind core): where a building of a given
 * slot size sits on the hex deck.
 *
 * - `'hex'`: the centre of the deck hex.
 * - `'small'`: a third of a hex. Joining the hex centre to corners 0, 2 and 4
 *   (30°, 150°, 270° in `hex.ts`'s corner order) splits the hex into three
 *   rhombi; rhombus `k` spans corners `2k`, `2k+1`, `2k+2`, so its centroid is
 *   half-way to corner `2k+1` (90°, 210°, 330°).
 *   Facing (slice 18): the rhombus's LONG diagonal (corner `2k` → corner
 *   `2k+2`, 1300 u) runs ACROSS the line from the hex centre (its short
 *   diagonal, centre → corner `2k+1`, is only 750 u), at 120°·k. A small
 *   building's long side lies along it ({@link rhombusFacingDeg}), so the three
 *   buildings of a hex are one another turned 120° about the hex centre.
 * - `'plate'`: the centre of the plate's middle hex (`plates.ts`).
 *
 * Angles are measured with `atan2(y, x)` in whatever frame the caller passes;
 * the player path passes game coordinates on both sides (client ghost and
 * server `place_structure` handler), so both get the same slot.
 *
 * Hot-path rule (invariant 14): {@link snapToDeckSlot} writes into `out` and
 * allocates nothing.
 */
import { hexCornerInto, pixelToAxialInto, type AxialHex, type HexPoint } from './hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto, plateOfHexInto, type PlateIndex } from './plates.js';

/** A kind's deck slot size (mirrors `StructureKind['deckSlot']`). */
export type DeckSlot = 'small' | 'hex' | 'plate';

/** A snapped deck slot: the building's centre, its hex, and (small slots
 *  only) which third of the hex. */
export interface DeckSnap {
  x: number;
  y: number;
  /** The deck hex the slot is in (for a plate: its middle hex). */
  q: number;
  r: number;
  /** `'small'`: rhombus 0..2 (centroid at 90° + 120°·k). Otherwise -1. */
  rhombus: number;
  /** The slot size actually snapped to (a connector may snap to `'plate'`). */
  slot: DeckSlot;
  /** Building turn, DEGREES (CCW, game frame). From {@link snapToDeckSlot}:
   *  `'small'` = the rhombus's long-diagonal facing ({@link rhombusFacingDeg}),
   *  otherwise -1 (the slot has no facing). `snapPlacementToDeck` resolves
   *  it to the kind's final turn. */
  rot: number;
}

const hexScratch: AxialHex = { q: 0, r: 0 };
const plateScratch: PlateIndex = { i: 0, j: 0 };
const centreScratch: AxialHex = { q: 0, r: 0 };
const pointScratch: HexPoint = { x: 0, y: 0 };

const DEG = 180 / Math.PI;

/** The rhombus (0..2) of a hex that a point at offset (dx, dy) from the hex
 *  centre falls in. The centre itself counts as rhombus 0. */
export function rhombusOf(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  // Degrees from the 30° separator, 0..360.
  let a = Math.atan2(dy, dx) * DEG - 30;
  a = ((a % 360) + 360) % 360;
  const k = Math.floor(a / 120);
  return k > 2 ? 2 : k;
}

/** The facing (degrees, CCW in the game frame: 0 / 120 / 240) of rhombus
 *  `k`'s long diagonal, corner `2k` → corner `2k + 2`. A box with its long
 *  side along local x, turned by this, lies along the rhombus. */
export function rhombusFacingDeg(k: number): number {
  return 120 * (((k % 3) + 3) % 3);
}

/** Allocation-free: the centroid of rhombus `k` of the hex centred at
 *  (cx, cy), written into `out` (half-way to corner `2k + 1`). */
export function rhombusCentroidInto(cx: number, cy: number, k: number, out: HexPoint): HexPoint {
  hexCornerInto(0, 0, DECK_HEX_SIZE, 2 * k + 1, out);
  out.x = cx + out.x / 2;
  out.y = cy + out.y / 2;
  return out;
}

/**
 * Allocation-free: snap (x, y) to the centre of the `slot`-sized deck slot
 * containing it, written into `out`. Idempotent: snapping a snapped point
 * returns the same point.
 */
export function snapToDeckSlot(slot: DeckSlot, x: number, y: number, out: DeckSnap): DeckSnap {
  pixelToAxialInto(x, y, DECK_HEX_SIZE, hexScratch);
  out.slot = slot;
  if (slot === 'plate') {
    plateOfHexInto(hexScratch.q, hexScratch.r, plateScratch, centreScratch);
    deckHexCentreInto(centreScratch.q, centreScratch.r, pointScratch);
    out.q = centreScratch.q;
    out.r = centreScratch.r;
    out.rhombus = -1;
    out.rot = -1;
  } else {
    deckHexCentreInto(hexScratch.q, hexScratch.r, pointScratch);
    out.q = hexScratch.q;
    out.r = hexScratch.r;
    if (slot === 'small') {
      const k = rhombusOf(x - pointScratch.x, y - pointScratch.y);
      rhombusCentroidInto(pointScratch.x, pointScratch.y, k, pointScratch);
      out.rhombus = k;
      out.rot = rhombusFacingDeg(k);
    } else {
      out.rhombus = -1;
      out.rot = -1;
    }
  }
  out.x = pointScratch.x;
  out.y = pointScratch.y;
  return out;
}

/**
 * The outline of a slot as closed polygons (flat `x0,y0,x1,y1,…`), relative
 * to the slot's snapped centre: one hex, one rhombus (`rhombus` 0..2), or the
 * plate's 7 hexes. For cached ghost art; allocates.
 */
export function deckSlotOutline(slot: DeckSlot, rhombus = 0): number[][] {
  const p: HexPoint = { x: 0, y: 0 };
  const hexAt = (cx: number, cy: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 6; i++) {
      hexCornerInto(cx, cy, DECK_HEX_SIZE, i, p);
      out.push(p.x, p.y);
    }
    return out;
  };
  if (slot === 'hex') return [hexAt(0, 0)];
  if (slot === 'plate') {
    const polys = [hexAt(0, 0)];
    // The 6 ring hexes, as offsets from the middle hex's centre.
    const c: HexPoint = { x: 0, y: 0 };
    const o: HexPoint = { x: 0, y: 0 };
    deckHexCentreInto(0, 0, o);
    for (const [dq, dr] of [[0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0]] as const) {
      deckHexCentreInto(dq, dr, c);
      polys.push(hexAt(c.x - o.x, c.y - o.y));
    }
    return polys;
  }
  const k = ((rhombus % 3) + 3) % 3;
  rhombusCentroidInto(0, 0, k, p);
  const gx = -p.x, gy = -p.y; // hex centre relative to the centroid
  const out: number[] = [gx, gy];
  for (let i = 2 * k; i <= 2 * k + 2; i++) {
    hexCornerInto(gx, gy, DECK_HEX_SIZE, i % 6, p);
    out.push(p.x, p.y);
  }
  return [out];
}
