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
 *
 * Facing (slice 18): the snap also decides the TURN (`out.rot`, degrees), so
 * ghost and server agree on it too. A small-slot building faces its third of
 * the hex: its footprint's long side lies along the rhombus's long diagonal
 * (`rhombusFacingDeg`: 0 / 120 / 240°, +90° when the footprint is taller
 * than wide). The player's own turn is IGNORED on a small slot (R does
 * nothing there; the two symmetric facings are left to the build mirror).
 * A quarter-turn-only kind takes the nearest quarter turn. Any other slot
 * keeps the player's turn, snapped by the deck rule
 * (`snapPlayerStructureRotation`).
 *
 * A fence (slice 19): a shield pylon snaps to the nearest hex CORNER
 * (`'corner'`), so its walls run along the seams (`deckLinks.ts`).
 */
import { getStructureKind, isConnectorKind, snapPlayerStructureRotation } from '../../shared-types/structureKinds.js';
import { snapToDeckSlot, type DeckSnap } from '../hex/deckSnap.js';
import { isPlateCentreHex } from '../hex/plates.js';
import { DECK_FENCE_POST_KIND } from './deckLinks.js';

/** Allocation-free: snap a player's requested point for `kind` to the centre
 *  of its deck slot (`kind.deckSlot`, or the plate centre for a connector in
 *  a plate's middle hex), and their requested turn `rotDeg` to the turn the
 *  building is placed at (`out.rot`, see the header), written into `out`. */
export function snapPlacementToDeck(kind: string, x: number, y: number, out: DeckSnap, rotDeg = 0): DeckSnap {
  const k = getStructureKind(kind);
  snapToDeckSlot(kind === DECK_FENCE_POST_KIND ? 'corner' : k.deckSlot, x, y, out);
  if (out.slot !== 'plate' && isConnectorKind(kind) && isPlateCentreHex(out.q, out.r)) snapToDeckSlot('plate', x, y, out);
  const faced = out.rot >= 0 ? out.rot + (k.footprint.h > k.footprint.w ? 90 : 0) : rotDeg;
  out.rot = snapPlayerStructureRotation(faced, true, kind);
  return out;
}
