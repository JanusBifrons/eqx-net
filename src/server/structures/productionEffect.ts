/**
 * Pure recipe-effect helpers for `ProductionSubsystem` (moved out to keep that
 * file under the god-file cap).
 */
import { RECIPES, type RecipeId, type RecipeOutput } from '../../shared-types/recipes.js';
import type { GoodId } from '../../shared-types/goods.js';
import type { EffectiveRecipe } from './ProductionSubsystem.js';

/** A recipe's base effect (no blueprint), cached per recipe. */
const BASE_EFFECT = new Map<RecipeId, EffectiveRecipe>();
export function baseEffect(id: RecipeId): EffectiveRecipe {
  let e = BASE_EFFECT.get(id);
  if (e === undefined) {
    const d = RECIPES[id];
    e = { inputs: d.inputs, outputs: d.outputs, cyclePulses: d.cyclePulses, yieldBonus: 0, quality: 0 };
    BASE_EFFECT.set(id, e);
  }
  return e;
}

/** A cycle's inputs as outputs (handing a loaded cycle back). Rare (recipe or
 *  blueprint change), so it may allocate. */
export function inputsAsOutputs(eff: EffectiveRecipe): readonly RecipeOutput[] {
  return Object.entries(eff.inputs).map(([good, n]) => ({ good: good as GoodId, n: n ?? 0 }));
}
