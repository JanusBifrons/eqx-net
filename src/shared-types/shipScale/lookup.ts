/**
 * Tuning lookups by kind id, for sites that hold an id rather than a kind
 * object (kept out of `tuning.ts`, which the catalogue itself imports).
 *
 * `GLOBAL_SHIP_TUNING` is the default fighter's tuning at this process's
 * scale: the value for size-dependent sites that have no ship kind in hand
 * (a lingering hull's hit radius, the loot collector's pickup). At 1× it is
 * exactly the old constants.
 */
import { DEFAULT_SHIP_KIND, getShipKind } from '../shipKinds.js';
import { shipTuning, type ShipTuning } from './tuning.js';

/** The tuning for a kind id (unknown ⇒ the default kind). */
export function tuningFor(kindId: string | null | undefined): ShipTuning {
  return shipTuning(getShipKind(kindId ?? null));
}

/** The default fighter's tuning at the current scale. */
export const GLOBAL_SHIP_TUNING: ShipTuning = shipTuning(getShipKind(DEFAULT_SHIP_KIND));
