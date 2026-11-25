/**
 * Base platforms — the placement ghost's deck snap (client side of the
 * two-sided snap, invariant 15). On a deck room (`preview.deck`) the live
 * ghost's point snaps through the same core `snapPlacementToDeck` the
 * server's `place_structure` handler runs, so the ghost sits exactly where
 * the structure will be placed. The pending (sent) ghost already sits on a
 * snapped point and is never re-snapped.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import { snapPlacementToDeck } from '../../../core/structures/deckPlacement.js';
import type { DeckSnap } from '../../../core/hex/deckSnap.js';

type Preview = NonNullable<RenderMirror['pendingPlacementPreview']>;

/** Shared scratch (invariant 14): read the result before the next call. */
const scratch: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1 };

/** The deck slot the live ghost at (x, y) snaps to, or null when the room has
 *  no deck (or this is the pending ghost). Allocation-free; the returned
 *  object is shared scratch. */
export function snapGhostToDeck(preview: Preview | null | undefined, x: number, y: number): DeckSnap | null {
  if (!preview || preview.deck !== true || preview.pending === true) return null;
  return snapPlacementToDeck(preview.kind, x, y, scratch);
}
