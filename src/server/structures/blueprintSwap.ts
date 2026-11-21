/**
 * The one blueprint swap: make a processor's slot fit a recipe. Used when the
 * owner picks a recipe (`set_recipe`) and when a recipe queue's head needs a
 * blueprint the slot doesn't hold (`ProductionSubsystem.step`, e.g. a Shipyard
 * queue going interceptor -> gunship).
 *
 * Loads the best matching blueprint through `StorageService.loadBlueprint` (its
 * selection rule; the old one goes back to storage in the same group), else
 * puts the old one back with `unloadBlueprint` (it stays if storage has no
 * room). A bound blueprint never leaves the slot: both calls refuse it.
 */
import type { StorageService } from '../cargo/StorageService.js';
import { blueprintProductFor, type RecipeId } from '../../shared-types/recipes.js';
import { blueprintQuality } from '../../shared-types/blueprints.js';
import type { StructureRecord } from './StructureRegistry.js';

/** Swap `rec`'s slot to a blueprint for `recipe`'s product. `shipUid` (the
 *  owner's own ship hold) is searched only when the network has none, exactly
 *  as a manual Load. A no-op when the slot already fits. */
export function swapBlueprintFor(
  storage: Pick<StorageService, 'loadBlueprint' | 'unloadBlueprint'>,
  rec: StructureRecord,
  recipe: RecipeId,
  shipUid?: string,
): void {
  const product = blueprintProductFor(recipe);
  if (rec.blueprint?.product === product) return;
  if (!storage.loadBlueprint(rec, product, blueprintQuality, shipUid) && rec.blueprint !== undefined) storage.unloadBlueprint(rec);
}
