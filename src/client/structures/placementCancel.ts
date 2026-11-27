import { useUIStore } from '../state/store';
import { placementEndsAfterPlace } from '@shared-types/packedStock';
import type { StructureKindId } from '@shared-types/structureKinds';
import { batchPlacementRejections, BatchPlacementChecker } from '../../core/structures/batchPlacement.js';
import type { PlacementRejection } from '../../core/structures/placementRules.js';
import { getGameClient } from '../net/clientSingleton.js';
import { ghostDeckContext } from '../render/pixi/placementDeckSnap.js';
import { commitChosenPlacement, PENDING_PLACEMENT_TIMEOUT_MS, sendPlaceStructures } from './structurePlacementClient';
import { commitFenceRun, endFenceRun, fenceRunRocks, isFenceRunKind } from './fenceRun';
import { PlacementGhostVerdict } from './placementGhostVerdict.js';
import {
  clearPlacementPlan, clearPlanRefused, getPlacementPlanCount, markPlannedRefused, plannedCountOfKind, plannedPlacements,
} from './placementPlan.js';

/**
 * How a placement ends (build-menu redesign M3). After a place you KEEP
 * PLACING the same building until you cancel; the Build sidebar comes back
 * when `placementKind` clears (BuildSidebarHost.tsx).
 *
 * Plan then Build: a Place adds to the planned list (`placementPlan.ts`);
 * Build (`buildPlacementPlan`) sends it as one `place_structures`.
 */

/** A Build in flight: nothing is added or re-sent until it lands, is
 *  refused, or times out. `sentAtMs` < 0 until the first frame stamps it. */
const flight = { active: false, baseline: 0, count: 0, sentAtMs: -1 };

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
 * room still places at once as a fence run (`fenceRun.ts`). Returns whether a
 * placement was planned (or, for a fence run, sent).
 */
export function commitPlacement(kindId: StructureKindId): boolean {
  if (flight.active) return false; // the plan is on its way: it is not edited
  watchPlanExit();
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
  if (!sendPlaceStructures(items)) return false;
  flight.active = true;
  flight.baseline = mirror.structures?.size ?? 0;
  flight.count = items.length;
  flight.sentAtMs = -1;
  return true;
}

/** `place_structures_refused`: nothing was placed. Keep the plan and mark
 *  each refused index red; Build may be pressed again. */
export function onPlaceStructuresRefused(refused: readonly { index: number }[]): void {
  flight.active = false;
  clearPlanRefused();
  for (let k = 0; k < refused.length; k++) markPlannedRefused(refused[k]!.index);
}

/**
 * Per frame (gameRafLoop): resolve a Build in flight. Success has no reply:
 * the room state's structures grew by the batch (`structureCount` ≥ the
 * count at send + the planned count, the dim-ghost rule
 * `pendingPlacementResolved` uses) ⇒ the plan landed and is cleared. Past
 * `PENDING_PLACEMENT_TIMEOUT_MS` without either, the plan stays and Build
 * may be pressed again. One boolean when idle; allocation-free.
 */
export function stepPlacementPlan(structureCount: number, nowMs: number): void {
  if (!flight.active) return;
  if (structureCount >= flight.baseline + flight.count) { dropPlan(); return; }
  if (flight.sentAtMs < 0) flight.sentAtMs = nowMs;
  else if (nowMs - flight.sentAtMs >= PENDING_PLACEMENT_TIMEOUT_MS) flight.active = false;
}
