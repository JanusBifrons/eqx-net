/**
 * Base-platforms player placement snap (invariant 15: ONE function, both
 * sides). The client ghost (`placementGhostUpdater` /
 * `rendererInputController.routePlacementPointer`) and the server's
 * `place_structure` handler both call {@link snapPlacementToDeck} when the
 * room's `deck` flag is on, so the ghost sits exactly where the server places.
 * `place()` itself never snaps (NPC seeding, restore and scenarios pass exact
 * centres).
 */
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { snapToDeckSlot, type DeckSnap } from '../hex/deckSnap.js';

/** Allocation-free: snap a player's requested point for `kind` to the centre
 *  of its deck slot (`kind.deckSlot`), written into `out`. */
export function snapPlacementToDeck(kind: string, x: number, y: number, out: DeckSnap): DeckSnap {
  return snapToDeckSlot(getStructureKind(kind).deckSlot, x, y, out);
}
