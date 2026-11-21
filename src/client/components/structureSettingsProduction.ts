/**
 * Production tab data for the building settings window: which kinds get the
 * tab, and what it reads from the structure slice (the recipe and the build
 * count, `prodCount` = outputs left; undefined = repeat forever; whether the
 * recipe can change; the blueprint slot).
 */
import { getGameClient } from '../net/clientSingleton';
import { BP_RUNS_ORIGINAL, effectiveRecipe, isProcessorKind } from '@shared-types/production';
import { RECIPES, recipesFor, type RecipeId } from '@shared-types/recipes';
import type { StructureRenderState } from '@core/contracts/IRenderer';

/** A building that makes things: a processor with at least one recipe whose
 *  output is goods, a packed structure or a hull (or a chunk refine), not
 *  only credits (habitat upkeep). */
export function makesThings(kindId: string): boolean {
  if (!isProcessorKind(kindId)) return false;
  return recipesFor(kindId).some((id) => RECIPES[id].chunkInput !== undefined || RECIPES[id].outputs.some((o) => !('credits' in o)));
}

/** A processor whose owner can pick between more than one recipe. */
export function canChangeRecipe(kindId: string): boolean {
  return isProcessorKind(kindId) && recipesFor(kindId).length > 1;
}

/** The loaded blueprint line ("BLUEPRINT original · quality 3"), or
 *  undefined when the slot is empty. Shared by the inspector and the tab.
 *  The server spends a copy's run when a cycle STARTS, so while a cycle is
 *  loaded (`prodFrac` set: the server sends it only for a loaded cycle) and
 *  the recipe spends runs, the build in progress is counted too:
 *  "2 runs left (1 building)", the number of items still to come. */
export function blueprintLineOf(
  st: Pick<StructureRenderState, 'bpRuns' | 'bpQuality' | 'prodFrac'>,
  spendsRuns: boolean,
): string | undefined {
  if (st.bpRuns === undefined) return undefined;
  const building = spendsRuns && st.prodFrac !== undefined;
  let runs: string;
  if (st.bpRuns === BP_RUNS_ORIGINAL) runs = 'original';
  else if (building) runs = `${st.bpRuns + 1} runs left (1 building)`;
  else runs = `${st.bpRuns} run${st.bpRuns === 1 ? '' : 's'}`;
  return `BLUEPRINT ${runs} · quality ${st.bpQuality ?? 0}`;
}

export interface ProductionView {
  recipe: RecipeId;
  /** Outputs left before it stops (0 = done); undefined = forever. */
  left: number | undefined;
  /** More than one recipe to pick from. */
  canChange: boolean;
  /** The recipe needs a blueprint loaded. */
  needsBlueprint: boolean;
  /** The loaded blueprint, or undefined when the slot is empty. */
  blueprintLine: string | undefined;
}

export function readProduction(entityId: number): ProductionView | null {
  const client = getGameClient();
  const kindId = client?.mirror.swarm?.get(entityId)?.shipKind;
  const st = client?.mirror.structures?.get(entityId);
  if (!st || !kindId || !isProcessorKind(kindId)) return null;
  const recipe = effectiveRecipe(kindId, st.recipe);
  const needsBlueprint = RECIPES[recipe].blueprintRequired;
  return {
    recipe, left: st.prodCount, canChange: canChangeRecipe(kindId),
    needsBlueprint, blueprintLine: blueprintLineOf(st, needsBlueprint),
  };
}

export function sameProduction(a: ProductionView | null, b: ProductionView | null): boolean {
  if (a === null || b === null) return a === b;
  return a.recipe === b.recipe && a.left === b.left && a.canChange === b.canChange
    && a.needsBlueprint === b.needsBlueprint && a.blueprintLine === b.blueprintLine;
}

/** The count label: "Forever", "Done", or "3 left". */
export function buildCountText(left: number | undefined): string {
  if (left === undefined) return 'Forever';
  return left === 0 ? 'Done' : `${left} left`;
}
