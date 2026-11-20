/**
 * Production tab data for the building settings window: which kinds get the
 * tab, and what it reads from the structure slice (the recipe and the build
 * count, `prodCount` = outputs left; undefined = repeat forever).
 */
import { getGameClient } from '../net/clientSingleton';
import { effectiveRecipe, isProcessorKind } from '@shared-types/production';
import { RECIPES, recipesFor, type RecipeId } from '@shared-types/recipes';

/** A building that makes things: a processor with at least one recipe whose
 *  output is goods, a packed structure or a hull (or a chunk refine), not
 *  only credits (habitat upkeep). */
export function makesThings(kindId: string): boolean {
  if (!isProcessorKind(kindId)) return false;
  return recipesFor(kindId).some((id) => RECIPES[id].chunkInput !== undefined || RECIPES[id].outputs.some((o) => !('credits' in o)));
}

export interface ProductionView {
  recipe: RecipeId;
  /** Outputs left before it stops (0 = done); undefined = forever. */
  left: number | undefined;
}

export function readProduction(entityId: number): ProductionView | null {
  const client = getGameClient();
  const kindId = client?.mirror.swarm?.get(entityId)?.shipKind;
  const st = client?.mirror.structures?.get(entityId);
  if (!st || !kindId || !isProcessorKind(kindId)) return null;
  return { recipe: effectiveRecipe(kindId, st.recipe), left: st.prodCount };
}

/** The count label: "Forever", "Done", or "3 left". */
export function buildCountText(left: number | undefined): string {
  if (left === undefined) return 'Forever';
  return left === 0 ? 'Done' : `${left} left`;
}
