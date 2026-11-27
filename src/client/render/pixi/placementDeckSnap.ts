/**
 * Base platforms — the placement ghost's deck snap (client side of the
 * two-sided snap, invariant 15). On a deck room (`preview.deck`) the live
 * ghost's point snaps through the same core `snapPlacementToDeck` the
 * server's `place_structure` handler runs, so the ghost sits exactly where
 * the structure will be placed. The pending (sent) ghost already sits on a
 * snapped point and is never re-snapped. The snap also decides the turn
 * (`rot`, degrees: a small building faces its third of the hex, slice 18);
 * the ghost is drawn and checked at it, and the server takes the same turn.
 * A road turns itself from its neighbours (roads, gates): the ghost folds the
 * core `roadJoinBits` over the mirror's structures, the server over its
 * registry, so both pick the same turn (`roadAutoTurnDeg`).
 */
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '@core/contracts/IRenderer';
import { snapPlacementToDeck, type RoadJoinsAt } from '../../../core/structures/deckPlacement.js';
import { DECK_ROAD_KIND, roadJoinBits, roadJoinEdges } from '../../../core/structures/deckGateRoad.js';
import { roadLocalArms } from './roadJoins.js';
import type { DeckSnap } from '../../../core/hex/deckSnap.js';
import { OwnerPlateList } from '../../../core/hex/plateSet.js';
import type { PlacementDeck } from '../../../core/structures/placementRules.js';
import { plateReachBoxAdd } from '../../../core/structures/plateClearance.js';
import { isPlateAnchor } from '../../../core/hex/plateSet.js';

type Preview = NonNullable<RenderMirror['pendingPlacementPreview']>;

/** Shared scratch (invariant 14): read the result before the next call. */
const scratch: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 };
const RAD_TO_DEG = 180 / Math.PI;

/** The structures a road ghost lines up with (the mirror's). */
export type GhostWorld = Pick<RenderMirror, 'structures' | 'swarm'>;

// Road joins over the mirror: module state + one function, made once (#14).
let joinSwarm: ReadonlyMap<number, SwarmRenderState> | undefined;
let joinStructs: ReadonlyMap<number, StructureRenderState> | undefined;
let joinQ = 0, joinR = 0, joinAcc = 0;
/** The world join bits of the last road ghost snapped (its overlay reads them). */
let lastJoins = 0;
function foldJoin(_st: StructureRenderState, id: number): void {
  const a = joinSwarm!.get(id);
  if (a !== undefined) joinAcc |= roadJoinBits(joinQ, joinR, a.shipKind, a.x, a.y);
}
const ghostRoadJoinsAt: RoadJoinsAt = (q, r) => {
  joinAcc = 0;
  if (joinStructs !== undefined && joinSwarm !== undefined) {
    joinQ = q; joinR = r;
    joinStructs.forEach(foldJoin);
  }
  lastJoins = joinAcc;
  return joinAcc;
};
function snapWith(preview: Preview, x: number, y: number, world: GhostWorld | undefined): DeckSnap {
  joinStructs = world?.structures; joinSwarm = world?.swarm;
  snapPlacementToDeck(preview.kind, x, y, scratch, preview.angle * RAD_TO_DEG, ghostRoadJoinsAt);
  joinStructs = undefined; joinSwarm = undefined;
  return scratch;
}

/** The world join bits (`roadJoinBits`) of the hex the last road ghost
 *  snapped to: what the placed road will join (its arms). */
export function lastGhostRoadJoins(): number {
  return lastJoins;
}

/** The deck slot the live ghost at (x, y) snaps to, or null when the room has
 *  no deck (or this is the pending ghost). `world`: the structures a road
 *  lines up with (none = a lone road). Allocation-free; the returned object is
 *  shared scratch. */
export function snapGhostToDeck(preview: Preview | null | undefined, x: number, y: number, world?: GhostWorld): DeckSnap | null {
  if (!preview || preview.deck !== true || preview.pending === true) return null;
  return snapWith(preview, x, y, world);
}

/** The turn (radians) a ghost is drawn at: on a deck room the snap's turn
 *  (slice 18), for the pending (sent) ghost too, since the player's held turn
 *  is not what a small building is placed at; otherwise `preview.angle`.
 *  The pending ghost's point is already snapped, so this re-snap moves
 *  nothing. Allocation-free. */
export function ghostDeckAngle(preview: Preview, world?: GhostWorld): number {
  if (preview.deck !== true) return preview.angle;
  return snapWith(preview, preview.x, preview.y, world).rot / RAD_TO_DEG;
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

/** The road ghost's LOCAL arm mask (`roadLocalArms`): the carriageway the
 *  road will be laid with at turn `angle` (radians), joining the roads and
 *  gates the last snap found (as the placed road's `roadJoins` will); -1
 *  when the ghost is not a road on a deck. Allocation-free. */
export function ghostRoadArms(preview: Preview, angle: number): number {
  if (preview.deck !== true || preview.kind !== DECK_ROAD_KIND) return -1;
  const world = roadJoinEdges(lastJoins);
  return roadLocalArms(world, angle * RAD_TO_DEG, preview.mirror === true);
}
