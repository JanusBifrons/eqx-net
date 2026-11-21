/**
 * Production tab data for the building settings window: which kinds get the
 * tab, and what it reads from the structure slice (the recipe and the build
 * count, `prodCount` = outputs left; undefined = repeat forever; whether the
 * recipe can change; the blueprint slot; the recipe queue after the head and
 * its repeat flag; which hull blueprints the slot and the network hold).
 */
import { getGameClient } from '../net/clientSingleton';
import { BP_RUNS_ORIGINAL, effectiveRecipe, isProcessorKind } from '@shared-types/production';
import { RECIPES, hullKindOf, recipesFor, type RecipeId } from '@shared-types/recipes';
import type { StructureRenderState } from '@core/contracts/IRenderer';

/** A building that makes things: a processor with at least one recipe whose
 *  output is goods, a packed structure or a hull (or a chunk refine), not
 *  only credits (habitat upkeep). */
export function makesThings(kindId: string): boolean {
  if (!isProcessorKind(kindId)) return false;
  return recipesFor(kindId).some((id) => RECIPES[id].chunkInput !== undefined || RECIPES[id].outputs.some((o) => !('credits' in o)));
}

/** The hull recipes a processor kind can run (the Build tab's tiles). */
export function hullRecipesFor(kindId: string): RecipeId[] {
  return isProcessorKind(kindId) ? recipesFor(kindId).filter((id) => hullKindOf(id) !== null) : [];
}

/** A processor whose recipes are hulls (a Shipyard): its Build tab is tiles. */
export function isHullYard(kindId: string): boolean {
  return hullRecipesFor(kindId).length > 0;
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

/** The slot is empty but a cycle is loaded on a recipe that spends runs: the
 *  server spent a copy's LAST run at cycle start and freed the slot, so that
 *  last hull is still building. Undefined otherwise. No quality: the wire
 *  drops it with the empty slot. Kept apart from `blueprintLineOf` so Swap and
 *  Unload (which key on a loaded blueprint) stay hidden. */
export function lastRunLineOf(
  st: Pick<StructureRenderState, 'bpRuns' | 'prodFrac'>,
  spendsRuns: boolean,
): string | undefined {
  if (!spendsRuns || st.bpRuns !== undefined || st.prodFrac === undefined) return undefined;
  return 'BLUEPRINT last run building · slot free';
}

export interface ProductionView {
  /** The processor kind (a catalogue processor). */
  kindId: string;
  recipe: RecipeId;
  /** The loaded cycle's progress 0..1, undefined = none loaded. */
  frac: number | undefined;
  /** Its recipes build hulls: the Build tab shows picture tiles. */
  hullYard: boolean;
  /** Outputs left before it stops (0 = done); undefined = forever. */
  left: number | undefined;
  /** More than one recipe to pick from. */
  canChange: boolean;
  /** The recipe needs a blueprint loaded. */
  needsBlueprint: boolean;
  /** The loaded blueprint, or undefined when the slot is empty. */
  blueprintLine: string | undefined;
  /** The empty slot's last-run-building line (see `lastRunLineOf`). */
  lastRunLine: string | undefined;
  /** The recipes queued after the head, in order (empty = none). A copy:
   *  the row's array is decoded in place. */
  queue: readonly RecipeId[];
  /** The queue loops (a finished head goes to the back). */
  repeat: boolean;
  /** The recipe the slot blueprint is for (null = none). */
  bpProduct: RecipeId | null;
  /** Recipes with a blueprint in the network's storage (a copy). */
  bpAvailable: readonly RecipeId[];
}

const NONE: readonly RecipeId[] = [];
const copyList = (l: readonly RecipeId[] | undefined): readonly RecipeId[] => (l === undefined || l.length === 0 ? NONE : l.slice());
function sameList(a: readonly RecipeId[], b: readonly RecipeId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function readProduction(entityId: number): ProductionView | null {
  const client = getGameClient();
  const kindId = client?.mirror.swarm?.get(entityId)?.shipKind;
  const st = client?.mirror.structures?.get(entityId);
  if (!st || !kindId || !isProcessorKind(kindId)) return null;
  const recipe = effectiveRecipe(kindId, st.recipe);
  const needsBlueprint = RECIPES[recipe].blueprintRequired;
  return {
    kindId, recipe, frac: st.prodFrac, hullYard: isHullYard(kindId), left: st.prodCount, canChange: canChangeRecipe(kindId),
    needsBlueprint, blueprintLine: blueprintLineOf(st, needsBlueprint),
    lastRunLine: lastRunLineOf(st, needsBlueprint),
    queue: copyList(st.prodQueue), repeat: st.prodQueueRepeat === true,
    bpProduct: st.bpProduct ?? null, bpAvailable: copyList(st.bpAvailable),
  };
}

export function sameProduction(a: ProductionView | null, b: ProductionView | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kindId === b.kindId && a.recipe === b.recipe && a.frac === b.frac && a.left === b.left && a.canChange === b.canChange
    && a.needsBlueprint === b.needsBlueprint && a.blueprintLine === b.blueprintLine
    && a.lastRunLine === b.lastRunLine && a.repeat === b.repeat && a.bpProduct === b.bpProduct
    && sameList(a.queue, b.queue) && sameList(a.bpAvailable, b.bpAvailable);
}

/** The count label: "Forever", "Done", or "3 left". */
export function buildCountText(left: number | undefined): string {
  if (left === undefined) return 'Forever';
  return left === 0 ? 'Done' : `${left} left`;
}
