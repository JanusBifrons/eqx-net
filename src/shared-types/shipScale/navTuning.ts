/**
 * Navigation numbers derived from a ship's tuning (kept out of `tuning.ts`,
 * which is at its god-file cap).
 */
import type { ShipKind } from '../shipKinds.js';
import { shipTuning } from './tuning.js';

/** What a nav route keeps from rock where it has room: the shield ball
 *  (radius + shieldPad) plus half a pad for steering error, never under
 *  `navClearance`, which is all a tight street gets (owner 2026-11-19,
 *  "margin where room"). 54 u for a fighter; a battleship's is its clearance. */
export function navComfort(kind: ShipKind): number {
  const t = shipTuning(kind);
  return Math.max(t.navClearance, kind.radius + t.shieldPad * 1.5);
}
