/**
 * The loot window's open rule (plan cargo-pods slices 10 + 16): a cargo pod
 * opens for a ship whose hull comes within `LOOT_OPEN_REACH` of the pod's
 * centre (about a ship length). One predicate for both sides (#15): the
 * server gates `cargo_query` / `cargo_move` on it and the client greys out
 * the Open button with it.
 */
import { LOOT_OPEN_REACH } from '../../shared-types/shipScale/lookup.js';
import { shipWithinHullReach } from '../combat/shipHitShape.js';

export function withinLootOpenReach(
  kindId: string | null | undefined, shieldUp: boolean,
  podX: number, podY: number, shipX: number, shipY: number, shipAngle: number,
): boolean {
  return shipWithinHullReach(kindId, shieldUp, podX, podY, shipX, shipY, shipAngle, LOOT_OPEN_REACH);
}
