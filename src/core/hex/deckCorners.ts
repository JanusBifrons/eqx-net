/**
 * Base platforms slice 19 — deck hex CORNERS and SEAMS (pure, blind core).
 * A fence on a deck is laid along the hex seams: its shield pylons sit on
 * hex corners (the `'corner'` deck slot, `deckSnap.ts`), and two pylons on
 * the two ends of one hex edge form a wall (`deckLinks.ts`
 * `DECK_LINK_SEAM_FENCE`, inside the shared `canConnect`).
 *
 * The deck lattice's nearest corner-to-corner distance IS the hex edge
 * (= `DECK_HEX_SIZE`, the circumradius of a regular hex), so "both on corners,
 * one edge apart" means "both ends of the same seam".
 *
 * Allocation-free (invariant 14): module scratch only.
 */
import { hexCornerInto, pixelToAxialInto, type AxialHex, type HexPoint } from './hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from './plates.js';

/** Slack on the corner / seam tests, world units: the client mirror's
 *  structure poses are wire-rounded, the server's are exact. */
export const DECK_CORNER_TOLERANCE = 4;

const HEX: AxialHex = { q: 0, r: 0 };
const CENTRE: HexPoint = { x: 0, y: 0 };
const CORNER: HexPoint = { x: 0, y: 0 };

/** Allocation-free: the deck hex corner nearest (x, y), written into `out`
 *  (corner of the hex holding the point; idempotent on a corner). */
export function nearestDeckCornerInto(x: number, y: number, out: HexPoint): HexPoint {
  pixelToAxialInto(x, y, DECK_HEX_SIZE, HEX);
  deckHexCentreInto(HEX.q, HEX.r, CENTRE);
  // Corners sit at 30° + 60°·i (`hex.ts` order): the nearest is the sector's.
  const a = Math.atan2(y - CENTRE.y, x - CENTRE.x) * (180 / Math.PI) - 30;
  const i = ((Math.round(a / 60) % 6) + 6) % 6;
  return hexCornerInto(CENTRE.x, CENTRE.y, DECK_HEX_SIZE, i, out);
}

/** Is (x, y) on a deck hex corner (within {@link DECK_CORNER_TOLERANCE})? */
export function isOnDeckCorner(x: number, y: number): boolean {
  nearestDeckCornerInto(x, y, CORNER);
  return Math.abs(CORNER.x - x) <= DECK_CORNER_TOLERANCE && Math.abs(CORNER.y - y) <= DECK_CORNER_TOLERANCE;
}

/** Are A and B the two ends of one deck hex edge (a seam)? Order-free. */
export function isDeckSeam(ax: number, ay: number, bx: number, by: number): boolean {
  const d = Math.hypot(bx - ax, by - ay);
  if (Math.abs(d - DECK_HEX_SIZE) > DECK_CORNER_TOLERANCE) return false;
  return isOnDeckCorner(ax, ay) && isOnDeckCorner(bx, by);
}
