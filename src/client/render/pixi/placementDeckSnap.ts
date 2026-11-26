/**
 * Base platforms — the placement ghost's deck snap (client side of the
 * two-sided snap, invariant 15). On a deck room (`preview.deck`) the live
 * ghost's point snaps through the same core `snapPlacementToDeck` the
 * server's `place_structure` handler runs, so the ghost sits exactly where
 * the structure will be placed. The pending (sent) ghost already sits on a
 * snapped point and is never re-snapped. The snap also decides the turn
 * (`rot`, degrees: a small building faces its third of the hex, slice 18);
 * the ghost is drawn and checked at it, and the server takes the same turn.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import { snapPlacementToDeck } from '../../../core/structures/deckPlacement.js';
import type { DeckSnap } from '../../../core/hex/deckSnap.js';
import { OwnerPlateList } from '../../../core/hex/plateSet.js';
import type { PlacementDeck } from '../../../core/structures/placementRules.js';
import { plateReachBoxAdd } from '../../../core/structures/plateClearance.js';
import { isPlateAnchor } from '../../../core/hex/plateSet.js';

type Preview = NonNullable<RenderMirror['pendingPlacementPreview']>;

/** Shared scratch (invariant 14): read the result before the next call. */
const scratch: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 };
const RAD_TO_DEG = 180 / Math.PI;

/** The deck slot the live ghost at (x, y) snaps to, or null when the room has
 *  no deck (or this is the pending ghost). Allocation-free; the returned
 *  object is shared scratch. */
export function snapGhostToDeck(preview: Preview | null | undefined, x: number, y: number): DeckSnap | null {
  if (!preview || preview.deck !== true || preview.pending === true) return null;
  return snapPlacementToDeck(preview.kind, x, y, scratch, preview.angle * RAD_TO_DEG);
}

/** The turn (radians) a ghost is drawn at: on a deck room the snap's turn
 *  (slice 18), for the pending (sent) ghost too, since the player's held turn
 *  is not what a small building is placed at; otherwise `preview.angle`.
 *  The pending ghost's point is already snapped, so this re-snap moves
 *  nothing. Allocation-free. */
export function ghostDeckAngle(preview: Preview): number {
  if (preview.deck !== true) return preview.angle;
  return snapPlacementToDeck(preview.kind, preview.x, preview.y, scratch, preview.angle * RAD_TO_DEG).rot / RAD_TO_DEG;
}

const plateList = new OwnerPlateList();
const deckCtx: PlacementDeck = { plates: plateList, owner: '' };

/** The ghost's `off-deck` context (the server's `placementRejection` deck
 *  arg) from the preview's plate copy, or null when the room has no deck.
 *  Allocation-free; the returned object is shared scratch. */
export function ghostDeckContext(preview: Preview | null | undefined): PlacementDeck | null {
  if (!preview || preview.deck !== true || preview.deckOwner === undefined) return null;
  plateList.set(preview.deckOwner, preview.deckPlates ?? []);
  deckCtx.owner = preview.deckOwner;
  return deckCtx;
}

/** The ghost's rock-query box (`ConnectorRenderer`'s preview obstacles),
 *  grown to the whole plate when the ghost lays one (a connector on a plate
 *  centre): the server fetches the same area, so `plate-blocked` agrees.
 *  Allocation-free. */
export function ghostPlateReachBoxAdd(kind: string, x: number, y: number, box: { x0: number; y0: number; x1: number; y1: number }): void {
  if (isPlateAnchor(kind, x, y)) plateReachBoxAdd(x, y, box);
}
