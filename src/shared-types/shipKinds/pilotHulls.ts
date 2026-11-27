/**
 * The hulls a pilot can fly, shared by the client's Hangar (`hangarKinds`) and
 * the server's sandbox fleet (`seedOwnedFleet`, docs/features/sandbox.md).
 *
 * A pilot hull is playable (not `npcOnly`) and not an `engineeringOnly` test
 * hull. A BASE hull is one per hull: a capital class's fit variants (rail,
 * lance, beam: `capitalClassAndFitOf`) fold into the class's own kind, the
 * same folding the Hangar's tiles use (first fit = the base kind).
 */
import { SHIP_KINDS_LIST } from './catalogueOrder.js';
import { capitalClassAndFitOf } from './capitals/index.js';
import type { ShipKind } from './types.js';

/** May a pilot fly this kind from the Hangar? */
export function isPilotHullKind(k: Pick<ShipKind, 'npcOnly' | 'engineeringOnly'>): boolean {
  return !k.npcOnly && !k.engineeringOnly;
}

/** Every pilot hull, in catalogue order. */
export const PILOT_HULL_KINDS_LIST: readonly ShipKind[] = Object.freeze(SHIP_KINDS_LIST.filter(isPilotHullKind));

/** Is `id` a base hull (not a capital fit variant)? */
export function isBaseHullId(id: string): boolean {
  const cf = capitalClassAndFitOf(id);
  return cf === null || cf.classId === id;
}

/** One kind per base hull (fit variants folded away), in catalogue order. */
export const BASE_PILOT_HULL_KINDS_LIST: readonly ShipKind[] = Object.freeze(
  PILOT_HULL_KINDS_LIST.filter((k) => isBaseHullId(k.id)),
);
