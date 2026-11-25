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
