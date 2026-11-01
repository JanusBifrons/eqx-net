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

function rec(id: string, kind: StructureRecord['kind'], over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, owner: 'alice', kind, subtypeIndex: 0, x: 0, y: 0, radius: 10,
    isConstructed: true, constructionProgress: 0, constructionCost: 0,
    isDeconstructing: false, minerals: 0, storedPower: 0, ...over,
  };
}

function world(recs: StructureRecord[], opts: { powered?: boolean; blueprintFor?: ProductionDeps['blueprintFor'] } = {}) {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const ids = recs.map((r) => r.id);
  const registry = { all: () => byId.values(), get: (id: string) => byId.get(id) } as unknown as StructureRegistry;
  const prod = new ProductionSubsystem({
    registry,
    powered: () => opts.powered ?? true,
    componentOf: () => ids,
    ...(opts.blueprintFor ? { blueprintFor: opts.blueprintFor } : {}),
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

  it('needs a blueprint for a blueprint recipe once the blueprint hook exists', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { alloy: 4, polymer: 2 }, blueprints: [] } });
    const fab = rec('f', 'fabricator');
    const { run } = world([bay, fab], { blueprintFor: () => null });
    run(1);
    expect(fab.prodState).toBe(PROD_STATE.needsBlueprint);
    expect(bay.hold!.goods.alloy).toBe(4);
  });

  it('a blueprint scales the recipe (fewer inputs here)', () => {
    const bay = rec('bay', 'cargo_bay', { hold: { goods: { alloy: 1, polymer: 1 }, blueprints: [] } });
    const fab = rec('f', 'fabricator');
    const { run } = world([bay, fab], {
      blueprintFor: () => ({ inputs: { alloy: 1, polymer: 1 }, outputs: [{ good: 'components', n: 1 }], cyclePulses: 2 }),
    });
    run(2);
    expect(bay.hold!.goods).toEqual({ components: 1 });
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

  it('a citadel pulse scans each component storage once, not once per processor', () => {
    // Deterministic work lock (the wall-clock budget lives in
    // benchmarks/structures-scale.bench.ts — CI runs unit tests with coverage).
    const recs: StructureRecord[] = [rec('cap', 'capital', { minerals: 1_000_000 })];
    for (let i = 0; i < 20; i++) recs.push(rec(`bay${i}`, 'cargo_bay', { hold: { goods: { minerals: 500 }, blueprints: [] } }));
    for (let i = 0; i < 60; i++) recs.push(rec(`s${i}`, 'smelter'));
    const byId = new Map(recs.map((r) => [r.id, r]));
    const ids = recs.map((r) => r.id);
    let gets = 0;
    let comps = 0;
    const registry = {
      all: () => byId.values(),
      get: (id: string) => { gets++; return byId.get(id); },
    } as unknown as StructureRegistry;
    const prod = new ProductionSubsystem({ registry, powered: () => true, componentOf: () => { comps++; return ids; } });
    for (let i = 0; i < 20; i++) prod.pulse(); // warm up
    gets = 0;
    comps = 0;
    prod.pulse();
    expect(comps).toBe(60); // one component lookup per processor (an array ref)
    expect(gets).toBe(ids.length); // but the network itself is collected ONCE
  });
});
