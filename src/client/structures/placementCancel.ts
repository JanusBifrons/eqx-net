import { useUIStore } from '../state/store';
import { placementEndsAfterPlace } from '@shared-types/packedStock';
import type { StructureKindId } from '@shared-types/structureKinds';
import { commitChosenPlacement } from './structurePlacementClient';
import { commitFenceRun, endFenceRun, isFenceRunKind } from './fenceRun';

/**
 * How a placement ends (build-menu redesign M3). After a place you KEEP
 * PLACING the same building until you cancel; the Build sidebar comes back
 * when `placementKind` clears (BuildSidebarHost.tsx).
 */

/**
 * Cancel the structure being placed (the ghost goes, Build stays). Every
 * player Cancel (the touch banner's Cancel, Escape, a mouse right-click) goes
 * through here. No-op when nothing is being placed. Ends a fence run.
 */
export function cancelPlacement(): void {
  endFenceRun();
  const ui = useUIStore.getState();
  if (ui.placementKind === null) return;
  ui.setPlacementKind(null);
}

/**
 * Place `kindId` at the chosen point: the ONE path for the touch Confirm and
 * the desktop click (gameRafLoop). Placement stays open for the next one,
 * except a place-once kind or the last crate (`placementEndsAfterPlace`).
 * A refused commit (blocked ghost) keeps placement open. A fence post on a
 * deck room places as a fence run (`fenceRun.ts`). Returns whether a
 * placement was sent.
 */
export function commitPlacement(kindId: StructureKindId): boolean {
  const ui = useUIStore.getState();
  const ends = placementEndsAfterPlace(kindId, ui.packedStock, ui.currentSectorKey !== null);
  const run = isFenceRunKind(kindId, ui.deck) ? commitFenceRun(kindId) : null;
  if (run === false || (run === null && !commitChosenPlacement(kindId))) return false;
  if (ends && useUIStore.getState().placementKind === kindId) ui.setPlacementKind(null);
  return true;
}
