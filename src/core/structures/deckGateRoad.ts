/**
 * Base platforms slice 21 — "gates where a road crosses a fence". On a deck
 * room a player's shield gate stands on a hex seam (`'edge'` deck slot,
 * `deckPlacement.ts`), and only where that seam borders a ROAD tile on either
 * side; elsewhere `placementRejection` refuses it with `'no-road'`. The ghost
 * and the server both run that one rule (invariant 15).
 *
 * The two hexes of a seam: a gate at the seam's midpoint, turned along the
 * seam (`rotDeg`), has the hex centres one inradius away on its local ±y.
 * Pure, allocation-free.
 */
import { DECK_CORNER_TOLERANCE, DECK_HEX_INRADIUS } from '../hex/deckCorners.js';
import { pixelToAxialInto, type AxialHex } from '../hex/hex.js';
import { DECK_HEX_SIZE } from '../hex/plates.js';

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
