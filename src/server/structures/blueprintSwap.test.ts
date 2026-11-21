/**
 * Building panels B3 — a mixed Shipyard queue (interceptor, gunship,
 * interceptor) swaps the hull blueprint in its one slot each time the head
 * changes hull, through the same `swapBlueprintFor` as `set_recipe`. Real
 * ProductionSubsystem + StorageService + HoldStore; hulls "launch" into a
 * counter so storage only holds goods and blueprints.
 */
import { describe, expect, it } from 'vitest';
import { ProductionSubsystem } from './ProductionSubsystem.js';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';
import { editRecipeQueue } from './productionQueue.js';
import { swapBlueprintFor } from './blueprintSwap.js';
import { StorageService } from '../cargo/StorageService.js';
import { HoldStore } from '../cargo/HoldStore.js';
import { structureUid } from '../cargo/storageHolds.js';
import { PROD_STATE } from '../../shared-types/production.js';
import { RECIPES, blueprintProductFor } from '../../shared-types/recipes.js';
import { structureKindToIndex, type StructureKindId } from '../../shared-types/structureKinds.js';
import type { BlueprintItem } from '../../shared-types/items.js';
import type { IPersistenceSink } from '../../core/contracts/IPersistenceSink.js';

const INTERCEPTOR = blueprintProductFor('build_interceptor');
const GUNSHIP = blueprintProductFor('build_gunship');
const I_PULSES = RECIPES.build_interceptor.cyclePulses;
const G_PULSES = RECIPES.build_gunship.cyclePulses;

function rec(id: string, kind: StructureKindId, x: number, over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, owner: 'p1', kind, subtypeIndex: structureKindToIndex(kind), x, y: 0, radius: 20,
    isConstructed: true, constructionProgress: 0, constructionCost: 0, isDeconstructing: false,
    minerals: 0, storedPower: 0, level: 1, uid: structureUid('s', 'p1', kind, x, 0), ...over,
  };
}

function bpo(uid: string, product: string, over: Partial<BlueprintItem> = {}): BlueprintItem {
  return { uid, product, kind: 'bpo', runs: null, material: 0, output: 0, research: 0, ...over };
}

function world(inStorage: BlueprintItem[], loaded: BlueprintItem) {
  const sink: IPersistenceSink = {
    enqueueCritical: () => {}, enqueueVolatile: () => {},
    enqueueCriticalAwaitable: () => Promise.resolve({}), shutdown: () => Promise.resolve({ drained: 0 }),
  };
  const holdStore = new HoldStore({ persistence: () => sink });
  const registry = new StructureRegistry();
  const capital = rec('cap', 'capital', 0, { minerals: 10_000 });
  const bay = rec('bay', 'cargo_bay', 200, {
    hold: { goods: { alloy: 100, components: 100, electronics: 100, machinery: 100 }, blueprints: [...inStorage] },
  });
  const yard = rec('yard', 'shipyard', 400, { recipe: 'build_interceptor', blueprint: loaded });
  for (const r of [capital, bay, yard]) registry.add(r);
  const ids = ['cap', 'bay', 'yard'];
  const storage = new StorageService({ holdStore, registry, sectorKey: () => 's', componentOf: () => ids });
  const launched: string[] = [];
  const prod = new ProductionSubsystem({
    registry, powered: () => true, componentOf: () => ids,
    launchHull: (_r, kind) => { launched.push(kind); return true; },
    swapBlueprint: (r, recipe) => swapBlueprintFor(storage, r, recipe),
  });
  const run = (n: number) => { for (let i = 0; i < n; i++) prod.pulse(); };
  const add = (recipe: 'build_interceptor' | 'build_gunship') => editRecipeQueue(prod, yard, { op: 'add', recipe });
  // Every blueprint in network storage (an unload goes to the first store).
  const stored = () => [capital, bay].flatMap((s) => s.hold?.blueprints ?? []).map((b) => b.product).sort();
  return { yard, bay, prod, run, add, launched, stored };
}

describe('recipe queue swaps the hull blueprint (building panels B3)', () => {
  it('interceptor -> gunship -> interceptor builds all three, swapping the slot each time', () => {
    const w = world([bpo('g', GUNSHIP)], bpo('i', INTERCEPTOR));
    w.add('build_gunship');
    w.add('build_interceptor');
    w.run(I_PULSES);
    expect(w.launched).toEqual(['interceptor']);
    expect(w.yard.recipe).toBe('build_gunship');
    w.run(1); // the gunship head swaps blueprints and loads its cycle
    expect(w.yard.blueprint?.product).toBe(GUNSHIP);
    expect(w.stored()).toEqual([INTERCEPTOR]);
    expect(w.yard.prodLoaded).toBe(true);
    w.run(G_PULSES - 1);
    expect(w.launched).toEqual(['interceptor', 'gunship']);
    w.run(I_PULSES);
    expect(w.yard.blueprint?.product).toBe(INTERCEPTOR);
    expect(w.stored()).toEqual([GUNSHIP]);
    expect(w.launched).toEqual(['interceptor', 'gunship', 'interceptor']);
    w.run(2);
    expect(w.yard.prodState).toBe(PROD_STATE.done);
  });

  it('no gunship blueprint: holds at the gunship in needsBlueprint; one added to storage resumes it', () => {
    const w = world([], bpo('i', INTERCEPTOR));
    w.add('build_gunship');
    w.add('build_interceptor');
    w.run(I_PULSES + 3);
    expect(w.launched).toEqual(['interceptor']);
    expect(w.yard.recipe).toBe('build_gunship');
    expect(w.yard.prodState).toBe(PROD_STATE.needsBlueprint);
    // The non-matching interceptor copy went back to storage; the slot is empty.
    expect(w.yard.blueprint).toBeUndefined();
    expect(w.stored()).toEqual([INTERCEPTOR]);
    w.bay.hold!.blueprints.push(bpo('g', GUNSHIP));
    w.run(G_PULSES);
    expect(w.launched).toEqual(['interceptor', 'gunship']);
    w.run(I_PULSES);
    expect(w.launched).toEqual(['interceptor', 'gunship', 'interceptor']);
  });

  it('removing the head (index 0) mid-cycle hands the cycle back, then the new head swaps blueprints', () => {
    const w = world([bpo('g', GUNSHIP)], bpo('i', INTERCEPTOR));
    w.add('build_gunship');
    w.run(3);
    expect(w.yard.prodLoaded).toBe(true);
    expect(w.yard.blueprint?.product).toBe(INTERCEPTOR); // never swapped mid-cycle
    expect(editRecipeQueue(w.prod, w.yard, { op: 'remove', index: 0 })).toBe(true);
    expect(w.yard.recipe).toBe('build_gunship');
    w.run(G_PULSES);
    expect(w.yard.blueprint?.product).toBe(GUNSHIP);
    expect(w.launched).toEqual(['gunship']);
  });

  it('a bound blueprint is never swapped out: the yard holds in needsBlueprint', () => {
    const w = world([bpo('g', GUNSHIP)], bpo('i', INTERCEPTOR, { bound: true }));
    w.add('build_gunship');
    w.run(I_PULSES + 3);
    expect(w.launched).toEqual(['interceptor']);
    expect(w.yard.recipe).toBe('build_gunship');
    expect(w.yard.prodState).toBe(PROD_STATE.needsBlueprint);
    expect(w.yard.blueprint?.uid).toBe('i');
    expect(w.stored()).toEqual([GUNSHIP]);
  });
});
