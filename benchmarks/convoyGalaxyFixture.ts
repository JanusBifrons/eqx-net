/**
 * The convoy planner's realistic WORST-CASE input (plan soft-leaping-truffle
 * v3, phase T budgets): every NPC base in today's galaxy (galaxyBasePlan →
 * growBase), with its rates read from its own structures the way
 * `SectorRoom.npcBaseTrade` reads them, every input empty (so every base
 * needs everything it uses) and every output piled up (so every base offers
 * everything it makes). Shared by `convoys.bench.ts` and
 * `tests/unit/convoyBudget.test.ts`.
 */
import { GALAXY_SECTORS, getSector } from '../src/core/galaxy/galaxy.js';
import { galaxyBasePlan } from '../src/core/bases/galaxyBases.js';
import { growBase } from '../src/core/bases/growBase.js';
import type { BaseTradeView } from '../src/core/economy/convoys.js';
import { RECIPES, type RecipeId } from '../src/shared-types/recipes.js';
import { isProcessorKind, defaultRecipeFor } from '../src/shared-types/production.js';
import { getStructureKind } from '../src/shared-types/structureKinds.js';
import type { GoodId } from '../src/shared-types/goods.js';

function add(m: Partial<Record<GoodId, number>>, g: GoodId, n: number): void {
  m[g] = (m[g] ?? 0) + n;
}

export function galaxyConvoyViews(): BaseTradeView[] {
  const out: BaseTradeView[] = [];
  for (const s of GALAXY_SECTORS) {
    for (const plan of galaxyBasePlan(s.key)) {
      const grown = growBase(plan.profile, plan.seed, getSector(s.key)!.features);
      const uses: Partial<Record<GoodId, number>> = {};
      const makes: Partial<Record<GoodId, number>> = {};
      for (const p of grown.placements) {
        const k = getStructureKind(p.kind);
        if (isProcessorKind(p.kind)) {
          const def = RECIPES[(p.recipe ?? defaultRecipeFor(p.kind)) as RecipeId];
          const perMin = 60 / Math.max(1, def.cyclePulses);
          for (const [g, n] of Object.entries(def.inputs)) add(uses, g as GoodId, (n ?? 0) * perMin);
          for (const o of def.outputs) if ('good' in o) add(makes, o.good, o.n * perMin);
        }
        if (k.fuelEveryPulses) add(uses, 'fuel', 60 / k.fuelEveryPulses);
        if (k.miningRate) add(makes, 'minerals', k.miningRate * 60);
        if (k.gasRate) add(makes, 'gas', k.gasRate * 60);
      }
      // Worst case: inputs empty, outputs piled high, room to receive.
      const stock: Partial<Record<GoodId, number>> = {};
      for (const [g, n] of Object.entries(makes)) stock[g as GoodId] = Math.ceil((n ?? 0) * 60);
      out.push({ key: `${s.key}|${plan.baseId}`, sectorKey: s.key, stock, freeCapacity: 50_000, uses, makes });
    }
  }
  return out;
}
