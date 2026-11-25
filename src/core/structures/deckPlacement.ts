/**
 * Base-platforms player placement snap (invariant 15: ONE function, both
 * sides). The client ghost (`placementGhostUpdater` /
 * `rendererInputController.routePlacementPointer`) and the server's
 * `place_structure` handler both call {@link snapPlacementToDeck} when the
 * room's `deck` flag is on, so the ghost sits exactly where the server places.
 * `place()` itself never snaps (NPC seeding, restore and scenarios pass exact
 * centres).
 *
 * Laying a plate (slice 8): a connector-kind dropped anywhere in a plate's
 * MIDDLE hex snaps to the plate centre (its anchor point, `out.slot` =
 * `'plate'`); elsewhere it keeps its own slot.
 */
import { getStructureKind, isConnectorKind } from '../../shared-types/structureKinds.js';
import { snapToDeckSlot, type DeckSnap } from '../hex/deckSnap.js';
import { isPlateCentreHex } from '../hex/plates.js';

/** Allocation-free: snap a player's requested point for `kind` to the centre
 *  of its deck slot (`kind.deckSlot`, or the plate centre for a connector in
 *  a plate's middle hex), written into `out`. */
export function snapPlacementToDeck(kind: string, x: number, y: number, out: DeckSnap): DeckSnap {
  snapToDeckSlot(getStructureKind(kind).deckSlot, x, y, out);
  if (out.slot !== 'plate' && isConnectorKind(kind) && isPlateCentreHex(out.q, out.r)) snapToDeckSlot('plate', x, y, out);
  return out;
}
