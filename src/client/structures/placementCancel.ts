import { useUIStore } from '../state/store';
import { placementEndsAfterPlace } from '@shared-types/packedStock';
import type { StructureKindId } from '@shared-types/structureKinds';
import { batchPlacementRejections, BatchPlacementChecker } from '../../core/structures/batchPlacement.js';
import type { PlacementRejection } from '../../core/structures/placementRules.js';
import { getGameClient } from '../net/clientSingleton.js';
import { ghostDeckContext } from '../render/pixi/placementDeckSnap.js';
import { PLACE_STRUCTURES_BATCH_ID_MAX } from '@shared-types/messages';
import { commitChosenPlacement, PENDING_PLACEMENT_TIMEOUT_MS, sendPlaceStructures } from './structurePlacementClient';
import { commitFenceRun, endFenceRun, fenceRunRocks, isFenceRunKind } from './fenceRun';
import { PlacementGhostVerdict } from './placementGhostVerdict.js';
import {
  clearPlacementPlan, clearPlanRefused, getPlacementPlanCount, markPlannedRefused, plannedCountOfKind, plannedPlacementHitIndex,
  plannedPlacements, removePlannedPlacement,
} from './placementPlan.js';
import { placementChosen } from './placementChosen.js';

/**
 * How a placement ends (build-menu redesign M3). After a place you KEEP
 * PLACING the same building until you cancel; the Build sidebar comes back
 * when `placementKind` clears (BuildSidebarHost.tsx).
 *
 * Plan then Build: a Place adds to the planned list (`placementPlan.ts`);
 * Build (`buildPlacementPlan`) sends it as one `place_structures`.
 */

/** A Build in flight: nothing is added or re-sent until the server's reply
 *  for its `batchId` (placed or refused) or a timeout. `sentAtMs` < 0 until
 *  the first frame stamps it. `batchId` counts Builds (wraps at the wire max). */
const flight = { active: false, batchId: 0, sentAtMs: -1 };

/** Is a Build waiting on the server (the Build button stays disabled)? */
export function isPlanBuildInFlight(): boolean {
  return flight.active;
}

/** Drop the plan and any Build in flight. */
function dropPlan(): void {
  flight.active = false;
  clearPlacementPlan();
}

let watching = false;
/** Leaving build mode (the Fly / Command switch, any exit) or the sector drops the plan. */
function watchPlanExit(): void {
  if (watching) return;
  watching = true;
  useUIStore.subscribe((s, prev) => {
    if ((prev.buildMode && !s.buildMode) || s.currentSectorKey !== prev.currentSectorKey) dropPlan();
  });
}

/**
 * Cancel the structure being placed (the ghost goes, Build stays). Every
 * player Cancel (the strip's ✕, Escape, a mouse right-click) goes through
 * here. Ends a fence run and drops the planned list.
 */
export function cancelPlacement(): void {
  endFenceRun();
  dropPlan();
  const ui = useUIStore.getState();
  if (ui.placementKind === null) return;
  ui.setPlacementKind(null);
}

/**
 * Place `kindId` at the chosen point: the ONE path for the touch Confirm and
 * the desktop click (gameRafLoop). It PLANS the building (Build sends the
 * plan). Placement stays open for the next one, except a place-once kind or
 * the last crate (`placementEndsAfterPlace`, counting the planned ones). A
 * refused commit (blocked ghost) keeps placement open. A fence post on a deck
 * room still places at once as a fence run (`fenceRun.ts`). A Place ON a
 * planned building (`planTapHitIndex`) removes that one from the plan
 * instead, unless the ghost is still held on the spot just planned. Returns whether a placement was planned (or, for a fence run,
 * sent), or a planned one removed.
 */
export function commitPlacement(kindId: StructureKindId): boolean {
  if (flight.active) return false; // the plan is on its way: it is not edited
  watchPlanExit();
  // Held on the spot just planned: nothing (a double-click never removes it).
  const hit = placementChosen.held ? -1 : plannedPlacementHitIndex(placementChosen.worldX, placementChosen.worldY);
  if (hit >= 0) return removePlannedPlacement(hit);
  const ui = useUIStore.getState();
  const ends = placementEndsAfterPlace(kindId, ui.packedStock, ui.currentSectorKey !== null && !ui.freeBuilds, plannedCountOfKind(kindId));
  const run = isFenceRunKind(kindId, ui.deck) ? commitFenceRun(kindId) : null;
  if (run === false || (run === null && !commitChosenPlacement(kindId))) return false;
  if (ends && useUIStore.getState().placementKind === kindId) ui.setPlacementKind(null);
  return true;
}

const checker = new BatchPlacementChecker();
const verdict = new PlacementGhostVerdict();
const badIndex: number[] = [];
const badCode: PlacementRejection[] = [];

/**
 * Build: send the whole planned list as one `place_structures`. First the
 * shared core batch check (`batchPlacementRejections`, the server's own rule
 * against the mirror's structures, rocks and deck) marks obviously refused
 * items red without a round trip (#15); then it sends only a clean plan.
 * Returns whether it was sent.
 */
export function buildPlacementPlan(): boolean {
  if (flight.active || getPlacementPlanCount() === 0) return false;
  const client = getGameClient();
  if (!client) return false;
  const mirror = client.mirror;
  const items = plannedPlacements();
  clearPlanRefused();
  if (mirror.swarm) {
    verdict.prepare(mirror.structures, mirror.swarm);
    const rocks = fenceRunRocks(mirror);
    batchPlacementRejections(checker, items, verdict.prepared(), ghostDeckContext(mirror.pendingPlacementPreview), badIndex, badCode, () => rocks);
    if (badIndex.length > 0) {
      for (let k = 0; k < badIndex.length; k++) markPlannedRefused(badIndex[k]!);
      return false;
    }
  }
  const batchId = flight.batchId >= PLACE_STRUCTURES_BATCH_ID_MAX ? 0 : flight.batchId + 1;
  if (!sendPlaceStructures(items, batchId)) return false;
  flight.active = true;
  flight.batchId = batchId;
  flight.sentAtMs = -1;
  return true;
}

/** Is this reply for the Build in flight? A reply to an older Build (one
 *  that timed out, or from before a ✕) is ignored. */
function replyIsCurrent(batchId: number): boolean {
  return flight.active && batchId === flight.batchId;
}

/** `place_structures_refused` for the Build in flight: nothing was placed.
 *  Keep the plan and mark each refused index red; Build may be pressed again. */
export function onPlaceStructuresRefused(batchId: number, refused: readonly { index: number }[]): void {
  if (!replyIsCurrent(batchId)) return;
  flight.active = false;
  clearPlanRefused();
  for (let k = 0; k < refused.length; k++) markPlannedRefused(refused[k]!.index);
}

/** `place_structures_placed` for the Build in flight: every planned
 *  building landed, so the plan is cleared. */
export function onPlaceStructuresPlaced(batchId: number): void {
  if (replyIsCurrent(batchId)) dropPlan();
}

/**
 * Per frame (gameRafLoop): time out a Build in flight. Past
 * `PENDING_PLACEMENT_TIMEOUT_MS` with no reply for its batchId, the plan
 * stays and Build may be pressed again (a late reply is then ignored). One
 * boolean when idle; allocation-free.
 */
export function stepPlacementPlan(nowMs: number): void {
  if (!flight.active) return;
  if (flight.sentAtMs < 0) flight.sentAtMs = nowMs;
  else if (nowMs - flight.sentAtMs >= PENDING_PLACEMENT_TIMEOUT_MS) flight.active = false;
}
