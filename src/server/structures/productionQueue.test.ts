/**
 * Building panels B2 — a processor's recipe queue: each entry is one build,
 * the head (`rec.recipe`) advances only after a completed cycle, repeat loops
 * the list, the cap counts the head, and `set_recipe` clears the queue.
 * Uses the Refinery's two blueprint-free recipes (ice → fuel, gas → fuel +
 * polymer); hull-blueprint swapping is in `blueprintSwap.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ProductionSubsystem } from './ProductionSubsystem.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';
import { editRecipeQueue } from './productionQueue.js';
import { MAX_RECIPE_QUEUE, PROD_STATE } from '../../shared-types/production.js';
import { RECIPES } from '../../shared-types/recipes.js';

const ICE = RECIPES.refine_ice_fuel.cyclePulses;
const GAS = RECIPES.refine_gas.cyclePulses;

function rec(id: string, kind: StructureRecord['kind'], over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, owner: 'alice', kind, subtypeIndex: 0, x: 0, y: 0, radius: 10,
    isConstructed: true, constructionProgress: 0, constructionCost: 0,
    isDeconstructing: false, minerals: 0, storedPower: 0, ...over,
  };
}

function world() {
  const bay = rec('bay', 'cargo_bay', { hold: { goods: { ice: 20, gas: 20 }, blueprints: [] } });
  const ref = rec('r', 'refinery', { recipe: 'refine_ice_fuel' });
  const byId = new Map([bay, ref].map((r) => [r.id, r]));
  const registry = { all: () => byId.values(), get: (id: string) => byId.get(id) } as unknown as StructureRegistry;
  const prod = new ProductionSubsystem({ registry, powered: () => true, componentOf: () => ['bay', 'r'] });
  const run = (n: number) => { for (let i = 0; i < n; i++) prod.pulse(); };
  const add = (recipe: 'refine_ice_fuel' | 'refine_gas') => editRecipeQueue(prod, ref, { op: 'add', recipe });
  return { bay, ref, prod, run, add };
}

describe('recipe queue (building panels B2)', () => {
  it('a mixed list ice -> gas -> ice builds one of each in order, then is done', () => {
    const { bay, ref, run, add } = world();
    expect(add('refine_gas')).toBe(true);
    expect(add('refine_ice_fuel')).toBe(true);
    expect(ref.prodCount).toBe(1); // the head is one build
    expect(ref.prodQueue).toEqual(['refine_gas', 'refine_ice_fuel']);
    run(ICE);
    expect(ref.recipe).toBe('refine_gas');
    expect(ref.prodQueue).toEqual(['refine_ice_fuel']);
    run(GAS);
    expect(ref.recipe).toBe('refine_ice_fuel');
    expect(ref.prodQueue).toEqual([]);
    run(ICE + 3);
    expect(ref.prodState).toBe(PROD_STATE.done);
    expect(bay.hold!.goods).toEqual({ ice: 16, gas: 16, fuel: 3, polymer: 1 });
  });

  it('repeat loops the list: a finished head goes to the back', () => {
    const { bay, ref, run, add, prod } = world();
    add('refine_gas');
    expect(editRecipeQueue(prod, ref, { op: 'repeat', on: true })).toBe(true);
    run(ICE);
    expect([ref.recipe, ...ref.prodQueue!]).toEqual(['refine_gas', 'refine_ice_fuel']);
    run(GAS);
    expect([ref.recipe, ...ref.prodQueue!]).toEqual(['refine_ice_fuel', 'refine_gas']);
    run(ICE + GAS);
    expect(bay.hold!.goods).toEqual({ ice: 16, gas: 12, fuel: 4, polymer: 2 });
    expect(ref.prodState).toBe(PROD_STATE.running);
  });

  it('the head never changes mid-cycle; queue edits behind it leave the loaded cycle alone', () => {
    const { ref, run, add, prod } = world();
    run(1);
    expect(ref.prodLoaded).toBe(true);
    add('refine_gas');
    add('refine_gas');
    expect(editRecipeQueue(prod, ref, { op: 'remove', index: 2 })).toBe(true);
    expect(editRecipeQueue(prod, ref, { op: 'repeat', on: true })).toBe(true);
    run(ICE - 2);
    expect(ref.recipe).toBe('refine_ice_fuel');
    expect(ref.prodLoaded).toBe(true);
    run(1);
    expect(ref.recipe).toBe('refine_gas');
    expect(ref.prodLoaded).toBe(false);
  });

  it('removing the head mid-cycle goes through setRecipe: inputs come back, the next entry runs', () => {
    const { bay, ref, run, add, prod } = world();
    run(1);
    add('refine_gas');
    expect(bay.hold!.goods.ice).toBe(18);
    expect(editRecipeQueue(prod, ref, { op: 'remove', index: 0 })).toBe(true);
    expect(bay.hold!.goods.ice).toBe(20);
    expect(ref.recipe).toBe('refine_gas');
    expect(ref.prodQueue).toEqual([]);
    expect(ref.prodLoaded).toBe(false);
    // The last entry can't be removed; out-of-range indexes are refused.
    expect(editRecipeQueue(prod, ref, { op: 'remove', index: 0 })).toBe(false);
    expect(editRecipeQueue(prod, ref, { op: 'remove', index: 1 })).toBe(false);
  });

  it('caps the list at MAX_RECIPE_QUEUE counting the head; wrong-kind recipes are refused', () => {
    const { ref, add, prod } = world();
    for (let i = 1; i < MAX_RECIPE_QUEUE; i++) expect(add('refine_gas')).toBe(true);
    expect(add('refine_gas')).toBe(false);
    expect(ref.prodQueue).toHaveLength(MAX_RECIPE_QUEUE - 1);
    expect(editRecipeQueue(prod, ref, { op: 'add', recipe: 'build_gunship' })).toBe(false);
  });

  it('set_recipe clears the queue and keeps its own count', () => {
    const { ref, add, prod } = world();
    add('refine_gas');
    expect(prod.setRecipe(ref, 'refine_gas', 3)).toBe(true);
    expect(ref.prodQueue).toBeUndefined();
    expect(ref.prodCount).toBe(3);
  });

  it('adding to a drained (done) queue starts the new entry', () => {
    const { ref, run, add } = world();
    add('refine_gas');
    run(ICE + GAS + 1);
    expect(ref.prodState).toBe(PROD_STATE.done);
    add('refine_ice_fuel');
    expect(ref.recipe).toBe('refine_ice_fuel');
    expect(ref.prodCount).toBe(1);
    run(1);
    expect(ref.prodState).toBe(PROD_STATE.running);
  });
});
