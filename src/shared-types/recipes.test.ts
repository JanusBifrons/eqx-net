/**
 * Production chain locks (plan soft-leaping-truffle v3, P1). These are the
 * authority over the balance numbers in `economy.ts` BASE_PRICES, `goods.ts`
 * weights and `recipes.ts`.
 */
import { describe, expect, it } from 'vitest';
import { GOOD_DEFS, GOOD_IDS, GOOD_STAGE_EXOTIC, HoldSchema, type GoodId } from './goods.js';
import { BASE_PRICES } from './economy.js';
import {
  GOOD_SINKS,
  GOOD_SOURCES,
  PROCESSOR_KIND_IDS,
  RECIPES,
  RECIPE_IDS,
  blueprintProductFor,
  packBillValue,
  packRecipeFor,
  packedKindOf,
  recipeFromIndex,
  recipeIndex,
  recipesFor,
  type RecipeDef,
} from './recipes.js';
import { STRUCTURE_KINDS_LIST } from './structureKinds.js';
import { STARTER_STRUCTURE_KINDS, blueprintProducts } from './blueprints.js';
import {
  ASTEROID_RESOURCE_IDS,
  ASTEROID_YIELD,
  asteroidMixFor,
  asteroidResourceFromIndex,
  asteroidResourceIndex,
  rollAsteroidResource,
} from './asteroidResources.js';

function inputValue(r: RecipeDef): number {
  let v = 0;
  for (const [g, n] of Object.entries(r.inputs)) v += BASE_PRICES[g as GoodId] * (n ?? 0);
  return v;
}
function outputValue(r: RecipeDef): number {
  let v = 0;
  for (const o of r.outputs) if ('good' in o) v += BASE_PRICES[o.good] * o.n;
  return v;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

describe('goods', () => {
  it('are append-only: the original four keep their order', () => {
    expect(GOOD_IDS.slice(0, 4)).toEqual(['minerals', 'salvage', 'alloy', 'core']);
  });

  it('every good has a definition, a price and a stage', () => {
    for (const g of GOOD_IDS) {
      expect(GOOD_DEFS[g].id).toBe(g);
      expect(GOOD_DEFS[g].weight).toBeGreaterThan(0);
      expect(BASE_PRICES[g]).toBeGreaterThan(0);
      expect([0, 1, 2, 3, 4]).toContain(GOOD_DEFS[g].stage);
    }
  });

  it('munitions are light (user: ammo is never a chore to carry)', () => {
    expect(GOOD_DEFS.munitions.weight).toBeLessThanOrEqual(0.1);
  });

  it('a hold with every good round-trips the strict schema', () => {
    const goods: Partial<Record<GoodId, number>> = {};
    GOOD_IDS.forEach((g, i) => (goods[g] = i + 1));
    const hold = { goods, blueprints: [] };
    expect(HoldSchema.parse(JSON.parse(JSON.stringify(hold)))).toEqual(hold);
  });
});

describe('recipes', () => {
  it('are append-only: ids are keys, indices round-trip', () => {
    expect(Object.keys(RECIPES).sort()).toEqual([...RECIPE_IDS].sort());
    for (const id of RECIPE_IDS) {
      expect(RECIPES[id].id).toBe(id);
      expect(recipeFromIndex(recipeIndex(id))).toBe(id);
    }
    expect(RECIPE_IDS[0]).toBe('smelt_alloy');
  });

  it('use positive whole quantities and at least one input, output and processor', () => {
    for (const id of RECIPE_IDS) {
      const r = RECIPES[id];
      expect(Object.keys(r.inputs).length).toBeGreaterThan(0);
      expect(r.outputs.length).toBeGreaterThan(0);
      expect(r.processors.length).toBeGreaterThan(0);
      expect(Number.isInteger(r.cyclePulses) && r.cyclePulses > 0).toBe(true);
      for (const n of Object.values(r.inputs)) expect(Number.isInteger(n) && n! > 0).toBe(true);
      for (const o of r.outputs) if ('good' in o) expect(Number.isInteger(o.n) && o.n > 0).toBe(true);
    }
  });

  it('every step is worth running but none prints money: output is 1.2–1.6× input value', () => {
    for (const id of RECIPE_IDS) {
      const r = RECIPES[id];
      if (packedKindOf(id) !== null) continue; // packed structures are priced by W4's markup
      const ratio = outputValue(r) / inputValue(r);
      expect(ratio, `${id} returns ${ratio.toFixed(2)}×`).toBeGreaterThanOrEqual(1.2);
      expect(ratio, `${id} returns ${ratio.toFixed(2)}×`).toBeLessThanOrEqual(1.6);
    }
  });

  it('value per unit of weight rises by stage (hauling products pays better than ore)', () => {
    const byStage: number[][] = [[], [], [], []];
    for (const g of GOOD_IDS) {
      const d = GOOD_DEFS[g];
      if (d.stage === GOOD_STAGE_EXOTIC) continue;
      byStage[d.stage]!.push(BASE_PRICES[g] / d.weight);
    }
    const medians = byStage.map(median);
    for (let s = 1; s < medians.length; s++) {
      expect(medians[s], `stage ${s} median density vs stage ${s - 1}`).toBeGreaterThanOrEqual(medians[s - 1]!);
    }
    expect(medians[3]!).toBeGreaterThan(medians[0]! * 4);
  });

  it('a recipe never makes a good of an earlier stage than its main output (except by-products)', () => {
    for (const id of RECIPE_IDS) {
      const r = RECIPES[id];
      const main = r.outputs[0]!;
      if (!('good' in main)) continue;
      for (const g of Object.keys(r.inputs) as GoodId[]) {
        expect(GOOD_DEFS[g].stage, `${id}: input ${g}`).toBeLessThanOrEqual(GOOD_DEFS[main.good].stage);
      }
    }
  });

  it('components and up need a blueprint; extraction-side refining does not', () => {
    for (const id of RECIPE_IDS) {
      const r = RECIPES[id];
      const main = r.outputs[0]!;
      if (!('good' in main)) continue;
      expect(r.blueprintRequired, id).toBe(GOOD_DEFS[main.good].stage >= 2);
    }
  });

  it('every processor kind runs at least one recipe', () => {
    for (const k of PROCESSOR_KIND_IDS) expect(recipesFor(k).length, k).toBeGreaterThan(0);
  });
});

describe('packed structures (user ruling: NPC factions make them, players mostly buy)', () => {
  it('every non-starter structure kind has exactly one pack recipe; starter kinds have none', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      const starter = STARTER_STRUCTURE_KINDS.includes(k.id);
      expect(packRecipeFor(k.id) === null, k.id).toBe(starter);
    }
  });

  it("pack recipes need the structure's blueprint, run at a Fabricator or Assembly Plant, and cost goods", () => {
    const products = new Set(blueprintProducts());
    for (const id of RECIPE_IDS) {
      const kind = packedKindOf(id);
      if (kind === null) continue;
      const r = RECIPES[id];
      expect(r.blueprintRequired, id).toBe(true);
      expect(r.outputs).toEqual([{ packed: kind }]);
      expect(['fabricator', 'assembly_plant']).toContain(r.processors[0]);
      expect(packBillValue(kind), id).toBeGreaterThan(0);
      expect(products.has(blueprintProductFor(id)), id).toBe(true);
    }
  });

  it('every blueprint recipe names a product Living World can make blueprints for', () => {
    const products = new Set(blueprintProducts());
    for (const id of RECIPE_IDS) if (RECIPES[id].blueprintRequired) expect(products.has(blueprintProductFor(id)), id).toBe(true);
  });
});

describe('no orphan goods', () => {
  const made = new Set<GoodId>();
  const used = new Set<GoodId>();
  for (const id of RECIPE_IDS) {
    for (const o of RECIPES[id].outputs) if ('good' in o) made.add(o.good);
    for (const g of Object.keys(RECIPES[id].inputs) as GoodId[]) used.add(g);
  }

  it('every good is made by a recipe or comes from extraction or loot', () => {
    for (const g of GOOD_IDS) {
      expect(made.has(g) || (GOOD_SOURCES[g]?.length ?? 0) > 0, `${g} has no source`).toBe(true);
    }
  });

  it('every good is used by a recipe or has another use', () => {
    for (const g of GOOD_IDS) {
      expect(used.has(g) || (GOOD_SINKS[g]?.length ?? 0) > 0, `${g} has no use`).toBe(true);
    }
  });
});

describe('asteroid resources', () => {
  it('each kind yields 10 whole units per 10 mined', () => {
    for (const id of ASTEROID_RESOURCE_IDS) {
      const total = Object.values(ASTEROID_YIELD[id]).reduce((a, b) => a + (b ?? 0), 0);
      expect(total).toBe(10);
      expect(asteroidResourceFromIndex(asteroidResourceIndex(id))).toBe(id);
    }
  });

  it('features shift the mix: nebulae add ice, minerals and black holes add crystal', () => {
    const plain = asteroidMixFor(['asteroid']);
    expect(asteroidMixFor(['nebula']).ice).toBeGreaterThan(plain.ice);
    expect(asteroidMixFor(['minerals']).crystal).toBeGreaterThan(plain.crystal);
    expect(asteroidMixFor(['blackhole']).crystal).toBeGreaterThan(plain.crystal);
  });

  it('the roll covers [0,1) and follows the mix', () => {
    const counts = { rock: 0, ice: 0, crystal: 0 };
    for (let i = 0; i < 1000; i++) counts[rollAsteroidResource(i / 1000, ['nebula'])]++;
    const mix = asteroidMixFor(['nebula']);
    const total = mix.rock + mix.ice + mix.crystal;
    for (const id of ASTEROID_RESOURCE_IDS) expect(Math.abs(counts[id] / 1000 - mix[id] / total)).toBeLessThan(0.01);
    expect(rollAsteroidResource(0.9999999, [])).toBe('crystal');
    expect(rollAsteroidResource(-1, [])).toBe('rock');
  });
});
