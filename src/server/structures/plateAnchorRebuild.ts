/**
 * Base platforms slice 9 (plan `.resume/base-platforms-plan.md`): a plate
 * survives damage. When a plate's anchor connector is DESTROYED in combat on
 * a deck room, a blueprint connector of the same owner goes back on the same
 * spot through the ordinary placement flow (`StructurePlacementSubsystem.place`:
 * every non-pre-built kind lands as an unbuilt blueprint). Blueprints anchor
 * plates, so the plate stays; an unbuilt node is a grid dead end, so the plate
 * goes dark until the owner's grid rebuilds it.
 *
 * Deliberate removal (`remove_structure`, deconstruction) never comes here:
 * those leave the world with `emitDestroyed: false`, and the plate goes.
 */
import { isPlateAnchor } from '../../core/hex/plateSet.js';
import type { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import type { StructureRecord } from './StructureRegistry.js';

/**
 * Call AFTER the destroyed record left the registry. Returns the new
 * blueprint's id, or null when nothing was left (deck off, not a plate
 * anchor, or placement refused). Discrete event, not a hot path.
 */
export function leavePlateBlueprint(
  deck: boolean,
  dead: Pick<StructureRecord, 'owner' | 'kind' | 'x' | 'y' | 'rot' | 'mirror'>,
  placement: Pick<StructurePlacementSubsystem, 'place'>,
): string | null {
  if (!deck || !isPlateAnchor(dead.kind, dead.x, dead.y)) return null;
  return placement.place(dead.owner, dead.kind, dead.x, dead.y, {
    rot: dead.rot,
    mirror: dead.mirror === true,
    // Over its own wreck pieces: the blueprint is a non-colliding hologram.
    ignoreObstacles: true,
  });
}
