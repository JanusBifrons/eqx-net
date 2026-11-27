import { useUIStore } from '../state/store';
import { placementEndsAfterPlace } from '@shared-types/packedStock';
import type { StructureKindId } from '@shared-types/structureKinds';
import { batchPlacementRejections, BatchPlacementChecker } from '../../core/structures/batchPlacement.js';
import type { PlacementRejection } from '../../core/structures/placementRules.js';
import { getGameClient } from '../net/clientSingleton.js';
import { ghostDeckContext } from '../render/pixi/placementDeckSnap.js';
import { commitChosenPlacement, holdPlanSent, sendPlaceStructures } from './structurePlacementClient';
import { dropPlacementPlan, isPlanBuildInFlight, nextPlanBatchId, notePlanSent } from './placementPlanFlight.js';

// The Build in flight and its replies live in the leaf `placementPlanFlight.ts`
// (the room handlers import it there); re-exported for the existing callers.
export { isPlanBuildInFlight, onPlaceStructuresPlaced, onPlaceStructuresRefused, stepPlacementPlan } from './placementPlanFlight.js';
import { commitFenceRun, endFenceRun, fenceRunRocks, isFenceRunKind } from './fenceRun';
import { PlacementGhostVerdict } from './placementGhostVerdict.js';
import {
  clearPlanRefused, getPlacementPlanCount, markPlannedRefused, plannedCountOfKind, plannedPlacementHitIndex,
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

let watching = false;
/** Leaving build mode (the Fly / Command switch, any exit) or the sector drops the plan. */
function watchPlanExit(): void {
  if (watching) return;
  watching = true;
  useUIStore.subscribe((s, prev) => {
    if ((prev.buildMode && !s.buildMode) || s.currentSectorKey !== prev.currentSectorKey) dropPlacementPlan();
  });
}

/**
 * Cancel the structure being placed (the ghost goes, Build stays). Every
 * player Cancel (the strip's ✕, Escape, a mouse right-click) goes through
 * here. Ends a fence run and drops the planned list.
 */
export function cancelPlacement(): void {
  endFenceRun();
  dropPlacementPlan();
  const ui = useUIStore.getState();
  if (ui.placementKind === null) return;
  ui.setPlacementKind(null);
}

/**
 * Place `kindId` at the chosen point: the ONE path for the touch Confirm and
 * the desktop click (gameRafLoop). It PLANS the building (Build sends the
 * plan). Placement stays open for the next one, except a place-once kind or
 * the last crate (`placementEndsAfterPlace`, counting the planned ones). A
 * refused commit (blocked ghost) keeps placement open. A fence post or gate
 * on a deck room plans its whole run (`fenceRun.ts`: the missing posts, then
 * the gate). A Place ON a planned building (`planTapHitIndex`) removes that
 * one from the plan instead, unless the ghost is still held on the spot just
 * planned. Returns whether anything was planned, or a planned one removed.
 */
export function commitPlacement(kindId: StructureKindId): boolean {
  if (isPlanBuildInFlight()) return false; // the plan is on its way: it is not edited
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
  if (isPlanBuildInFlight() || getPlacementPlanCount() === 0) return false;
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
  const batchId = nextPlanBatchId();
  if (!sendPlaceStructures(items, batchId)) return false;
  notePlanSent(batchId, mirror.structures?.size ?? 0);
  holdPlanSent(); // the ghost on the last planned spot stays held, as after a sent Place
  return true;
}

