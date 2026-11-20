/**
 * Build count (job 2E) — "build 3, then stop". One optional number on a
 * processor (`rec.prodCount`, outputs left), set by `set_recipe`'s `count`.
 * Absent ⇒ repeat forever (the old behaviour). Each completed output spends
 * one; at 0 the processor goes `done` and starts nothing new. A cycle already
 * loaded finishes (its inputs are taken); a chunk recipe holds its chunk.
 */
import { PROD_STATE } from '../../shared-types/production.js';
import { RECIPES, type RecipeId } from '../../shared-types/recipes.js';
import type { StructureRecord } from './StructureRegistry.js';

/** True (and the state set to `done`) when the count is used up and this
 *  pulse must not start or run anything. */
export function haltAtBuildCount(rec: StructureRecord, loaded: boolean, recipe: RecipeId): boolean {
  if (rec.prodCount !== 0) return false;
  if (loaded && RECIPES[recipe].chunkInput === undefined) return false;
  rec.prodState = PROD_STATE.done;
  return true;
}

/** One output completed: spend one from the count (if any). */
export function spendBuildCount(rec: StructureRecord): void {
  if (rec.prodCount !== undefined && rec.prodCount > 0) rec.prodCount--;
}
