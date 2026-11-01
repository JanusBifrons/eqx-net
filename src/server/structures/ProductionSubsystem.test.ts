/**
 * P2b (plan soft-leaping-truffle v3) — the production step: take inputs from
 * network storage, run a cycle while powered, put outputs back; starved,
 * blocked, unpowered and needs-blueprint states; round-robin under scarcity;
 * conservation; no steady-state allocation.
 */
import { describe, expect, it } from 'vitest';
import { ProductionSubsystem, type ProductionDeps } from './ProductionSubsystem.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';
import { PROD_STATE } from '../../shared-types/production.js';
import { RECIPES } from '../../shared-types/recipes.js';
import type { BlueprintItem } from '../../shared-types/items.js';

function bp(product: string, over: Partial<BlueprintItem> = {}): BlueprintItem {
  return { uid: 'bp1', product, kind: 'bpc', runs: 10, material: 0, output: 0, research: 0, ...over };
}

function rec(id: string, kind: StructureRecord['kind'], over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, owner: 'alice', kind, subtypeIndex: 0, x: 0, y: 0, radius: 10,
    isConstructed: true, constructionProgress: 0, constructionCost: 0,
    isDeconstructing: false, minerals: 0, storedPower: 0, ...over,
  };
}

function world(recs: StructureRecord[], opts: { powered?: boolean; onBlueprintSpent?: ProductionDeps['onBlueprintSpent'] } = {}) {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const ids = recs.map((r) => r.id);
  const registry = { all: () => byId.values(), get: (id: string) => byId.get(id) } as unknown as StructureRegistry;
  const prod = new ProductionSubsystem({
    registry,
    powered: () => opts.powered ?? true,
    componentOf: () => ids,
    ...(opts.onBlueprintSpent ? { onBlueprintSpent: opts.onBlueprintSpent } : {}),
  });
  const run = (n: number) => { for (let i = 0; i < n; i++) prod.pulse(); };
  return { prod, run };
}

const SMELT = RECIPES.smelt_alloy.cyclePulses;

describe('ProductionSubsystem', () => {
  it('a smelter turns network minerals into alloy, one cycle per cyclePulses', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { minerals: 25 }, blueprints: [] } });
    const smelter = rec('s', 'smelter');
    const { run } = world([bay, smelter]);
    run(SMELT);
    expect(smelter.prodState).toBe(PROD_STATE.running);
    expect(bay.hold!.goods).toEqual({ minerals: 15, alloy: 1 });
    run(SMELT);
    expect(bay.hold!.goods).toEqual({ minerals: 5, alloy: 2 });
  });

  it('a starved processor reports the missing input and takes nothing', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { minerals: 3 }, blueprints: [] } });
    const smelter = rec('s', 'smelter');
    const { run } = world([bay, smelter]);
    run(1);
    expect(smelter.prodState).toBe(PROD_STATE.starved);
    expect(smelter.prodMissing).toBe('minerals');
    expect(bay.hold!.goods.minerals).toBe(3);
  });

  it('draws minerals from a Capital bank when holds run out', () => {
    const capital = rec('c', 'capital', { minerals: 10 });
    const bay = rec('bay', 'cargo_bay', { hold: { goods: {}, blueprints: [] } });
    const smelter = rec('s', 'smelter');
    const { run } = world([capital, bay, smelter]);
    run(SMELT);
    expect(capital.minerals).toBe(0);
    expect((capital.hold?.goods.alloy ?? 0) + (bay.hold?.goods.alloy ?? 0)).toBe(1);
  });

  it('blocks when storage is full, then finishes once there is room', () => {
    // A Cargo Bay holds 2000 weight. After the smelter takes its 10 minerals
    // (weight 1) the bay has 1 weight free: too little for alloy (weight 2).
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { salvage: 1999, minerals: 10 }, blueprints: [] } });
    const smelter = rec('s', 'smelter');
    const { run } = world([bay, smelter]);
    run(SMELT);
    expect(smelter.prodState).toBe(PROD_STATE.blocked);
    expect(bay.hold!.goods.alloy).toBeUndefined();
    expect(bay.hold!.goods.minerals).toBeUndefined(); // inputs stay consumed (loaded)
    run(3);
    expect(smelter.prodState).toBe(PROD_STATE.blocked);
    bay.hold!.goods.salvage = 1000; // make room
    run(1);
    expect(smelter.prodState).toBe(PROD_STATE.running);
    expect(bay.hold!.goods.alloy).toBe(1);
  });

  it('pauses without power and does not consume inputs', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { minerals: 10 }, blueprints: [] } });
    const smelter = rec('s', 'smelter');
    const { run } = world([bay, smelter], { powered: false });
    run(10);
    expect(smelter.prodState).toBe(PROD_STATE.unpowered);
    expect(bay.hold!.goods.minerals).toBe(10);
  });

  it('an unbuilt processor does nothing', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { minerals: 10 }, blueprints: [] } });
    const smelter = rec('s', 'smelter', { isConstructed: false });
    const { run } = world([bay, smelter]);
    run(10);
    expect(smelter.prodState).toBe(PROD_STATE.none);
    expect(bay.hold!.goods.minerals).toBe(10);
  });

  it('a blueprint recipe needs a matching blueprint in the slot', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { alloy: 4, polymer: 2 }, blueprints: [] } });
    const fab = rec('f', 'fabricator');
    const { run } = world([bay, fab]);
    run(1);
    expect(fab.prodState).toBe(PROD_STATE.needsBlueprint);
    fab.blueprint = bp('recipe:fab_electronics'); // wrong product
    run(1);
    expect(fab.prodState).toBe(PROD_STATE.needsBlueprint);
    expect(bay.hold!.goods.alloy).toBe(4);
    fab.blueprint = bp('recipe:fab_components');
    run(1);
    expect(fab.prodState).toBe(PROD_STATE.running);
  });

  it('material efficiency trims inputs; a copy spends one run per cycle and leaves the slot when used up', () => {
    // material 10 ⇒ 90 % of inputs, each at least 1: alloy 2 → 2, polymer 1 → 1.
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { alloy: 10, polymer: 10 }, blueprints: [] } });
    const fab = rec('f', 'fabricator', { blueprint: bp('recipe:fab_components', { runs: 2, material: 10 }) });
    let spent = 0;
    const { run } = world([bay, fab], { onBlueprintSpent: () => spent++ });
    run(RECIPES.fab_components.cyclePulses * 2);
    expect(spent).toBe(2);
    expect(fab.blueprint).toBeUndefined();
    expect(bay.hold!.goods.components).toBe(2);
    run(1);
    expect(fab.prodState).toBe(PROD_STATE.needsBlueprint);
  });

  it('an original never runs out', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { alloy: 40, polymer: 20 }, blueprints: [] } });
    const fab = rec('f', 'fabricator', { blueprint: bp('recipe:fab_components', { kind: 'bpo', runs: null }) });
    world([bay, fab]).run(RECIPES.fab_components.cyclePulses * 5);
    expect(fab.blueprint).toBeDefined();
    expect(bay.hold!.goods.components).toBe(5);
  });

  it('a pack recipe puts a PACKED structure into storage, carrying the blueprint quality', () => {
    const bill = RECIPES.pack_smelter.inputs;
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { ...bill }, blueprints: [] } });
    const fab = rec('f', 'fabricator', { recipe: 'pack_smelter', blueprint: bp('structure:smelter', { output: 80 }) });
    world([bay, fab]).run(RECIPES.pack_smelter.cyclePulses);
    expect(bay.hold!.packed).toEqual([{ product: 'structure:smelter', quality: 80 }]);
    expect(Object.keys(bay.hold!.goods)).toHaveLength(0);
  });

  it('output quality gives extra units, deterministically', () => {
    const make = () => {
      const bay = rec('bay', 'cargo_bay', { hold: { goods: { alloy: 400, polymer: 200 }, blueprints: [] } });
      const fab = rec('f', 'fabricator', { blueprint: bp('recipe:fab_components', { kind: 'bpo', runs: null, output: 100 }) });
      world([bay, fab]).run(RECIPES.fab_components.cyclePulses * 100);
      return bay.hold!.goods.components!;
    };
    const a = make();
    expect(a).toBeGreaterThan(100); // ~12 % bonus at quality 100
    expect(a).toBeLessThan(130);
    expect(make()).toBe(a);
  });

  it('shares scarce inputs round-robin, deterministically', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { minerals: 10 }, blueprints: [] } });
    const a = rec('a', 'smelter');
    const b = rec('b', 'smelter');
    const { run } = world([bay, a, b]);
    run(1);
    // Only one cycle's worth: exactly one smelter loaded, the other starved.
    expect([a.prodLoaded, b.prodLoaded].filter(Boolean)).toHaveLength(1);
    const first = a.prodLoaded ? 'a' : 'b';
    // Re-run the same setup: the same smelter wins.
    const bay2 = rec('bay', 'cargo_bay', { hold: { goods: { minerals: 10 }, blueprints: [] } });
    const a2 = rec('a', 'smelter');
    const b2 = rec('b', 'smelter');
    world([bay2, a2, b2]).run(1);
    expect(a2.prodLoaded ? 'a' : 'b').toBe(first);
  });

  it('conserves value: inputs consumed equal cycles × recipe inputs', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { gas: 40 }, blueprints: [] } });
    const refinery = rec('r', 'refinery');
    const { prod, run } = world([bay, refinery]);
    expect(prod.setRecipe(refinery, 'refine_gas')).toBe(true);
    run(RECIPES.refine_gas.cyclePulses * 3);
    expect(prod.cyclesCompleted).toBe(3);
    expect(bay.hold!.goods).toEqual({ gas: 40 - 3 * 4, fuel: 3, polymer: 3 });
  });

  it('changing recipe mid-cycle hands the loaded inputs back', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { ice: 10 }, blueprints: [] } });
    const refinery = rec('r', 'refinery');
    const { prod, run } = world([bay, refinery]);
    run(1); // refine_ice_fuel loads 2 ice
    expect(bay.hold!.goods.ice).toBe(8);
    expect(prod.setRecipe(refinery, 'refine_gas')).toBe(true);
    expect(bay.hold!.goods.ice).toBe(10);
    expect(refinery.prodLoaded).toBe(false);
    expect(prod.setRecipe(refinery, 'smelt_alloy')).toBe(false); // not a refinery recipe
  });

  it('only same-owner storage feeds a processor', () => {
    const theirs = rec('bay', 'cargo_bay', { owner: 'bob', hold: { goods: { minerals: 50 }, blueprints: [] } });
    const smelter = rec('s', 'smelter');
    world([theirs, smelter]).run(1);
    expect(smelter.prodState).toBe(PROD_STATE.starved);
    expect(theirs.hold!.goods.minerals).toBe(50);
  });

  it('steady state allocates little: a 60-processor citadel pulse stays cheap', () => {
    const recs: StructureRecord[] = [rec('cap', 'capital', { minerals: 1_000_000 })];
    for (let i = 0; i < 20; i++) recs.push(rec(`bay${i}`, 'cargo_bay', { hold: { goods: { minerals: 500 }, blueprints: [] } }));
    for (let i = 0; i < 60; i++) recs.push(rec(`s${i}`, 'smelter'));
    const { run } = world(recs);
    run(20); // warm up
    const t0 = performance.now();
    run(200);
    const perPulse = (performance.now() - t0) / 200;
    // Budget (plan): ≤ 0.3 ms per pulse at a citadel with ~60 processors.
    expect(perPulse).toBeLessThan(0.3);
  });
});
