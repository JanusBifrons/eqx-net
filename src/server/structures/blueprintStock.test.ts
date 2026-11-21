/**
 * Building panels B7 — a Shipyard's row reports its slot blueprint and which
 * hull blueprints its network storage holds (`bpAvail`), refreshed on the 1 Hz
 * production pulse. Real ProductionSubsystem + StorageService + HoldStore.
 */
import { describe, expect, it } from 'vitest';
import { ProductionSubsystem } from './ProductionSubsystem.js';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';
import { blueprintStockMask, tracksBlueprintStock } from './blueprintStock.js';
import { StorageService } from '../cargo/StorageService.js';
import { HoldStore } from '../cargo/HoldStore.js';
import { structureUid } from '../cargo/storageHolds.js';
import { decodeBpAvail, decodeBpProduct, encodeBpProduct, encodeProdQ1 } from '../../shared-types/production.js';
import { blueprintProductFor } from '../../shared-types/recipes.js';
import { structureKindToIndex, type StructureKindId } from '../../shared-types/structureKinds.js';
import type { BlueprintItem } from '../../shared-types/items.js';
import type { IPersistenceSink } from '../../core/contracts/IPersistenceSink.js';

const INTERCEPTOR = blueprintProductFor('build_interceptor');
const GUNSHIP = blueprintProductFor('build_gunship');

function rec(id: string, kind: StructureKindId, x: number, over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, owner: 'p1', kind, subtypeIndex: structureKindToIndex(kind), x, y: 0, radius: 20,
    isConstructed: true, constructionProgress: 0, constructionCost: 0, isDeconstructing: false,
    minerals: 0, storedPower: 0, level: 1, uid: structureUid('s', 'p1', kind, x, 0), ...over,
  };
}

function bpc(uid: string, product: string, runs = 3): BlueprintItem {
  return { uid, product, kind: 'bpc', runs, material: 0, output: 0, research: 0 };
}

function world() {
  const sink: IPersistenceSink = {
    enqueueCritical: () => {}, enqueueVolatile: () => {},
    enqueueCriticalAwaitable: () => Promise.resolve({}), shutdown: () => Promise.resolve({ drained: 0 }),
  };
  const holdStore = new HoldStore({ persistence: () => sink });
  const registry = new StructureRegistry();
  const capital = rec('cap', 'capital', 0);
  const bay = rec('bay', 'cargo_bay', 200, { hold: { goods: {}, blueprints: [bpc('g', GUNSHIP)] } });
  const yard = rec('yard', 'shipyard', 400, { recipe: 'build_interceptor', blueprint: bpc('i', INTERCEPTOR) });
  for (const r of [capital, bay, yard]) registry.add(r);
  const ids = ['cap', 'bay', 'yard'];
  const storage = new StorageService({ holdStore, registry, sectorKey: () => 's', componentOf: () => ids });
  const prod = new ProductionSubsystem({ registry, powered: () => true, componentOf: () => ids });
  return { yard, bay, storage, prod };
}

/** What the yard's row tells a client (the same helpers structuresSlice and
 *  the client decode use). */
function row(yard: StructureRecord): { slot: string | null; stock: string[] } {
  const q1 = encodeProdQ1(yard.prodQueue, yard.prodQueueRepeat, encodeBpProduct('shipyard', yard.blueprint?.product));
  return { slot: decodeBpProduct('shipyard', q1), stock: decodeBpAvail('shipyard', yard.bpAvail, []) };
}

describe('Shipyard blueprint stock (building panels B7)', () => {
  it('reports the interceptor in the slot and the gunship in a Cargo Bay; drops the gunship once it is taken out', () => {
    const w = world();
    w.prod.pulse();
    expect(row(w.yard)).toEqual({ slot: 'build_interceptor', stock: ['build_gunship'] });
    // Taken out of the bay (a player moves it to their ship).
    w.bay.hold!.blueprints.length = 0;
    w.prod.pulse();
    expect(row(w.yard)).toEqual({ slot: 'build_interceptor', stock: [] });
  });

  it('a slot swap moves the interceptor into storage and the gunship into the slot', () => {
    const w = world();
    expect(w.storage.loadBlueprint(w.yard, GUNSHIP, () => 0)).toBe(true);
    w.prod.pulse();
    expect(row(w.yard)).toEqual({ slot: 'build_gunship', stock: ['build_interceptor'] });
  });

  it('a used-up copy in storage does not count; storage off the network does not count', () => {
    const w = world();
    w.bay.hold!.blueprints[0] = bpc('g', GUNSHIP, 0);
    w.prod.pulse();
    expect(row(w.yard).stock).toEqual([]);
    w.bay.hold!.blueprints[0] = bpc('g', GUNSHIP);
    w.bay.owner = 'p2'; // another owner's bay in the same grid component
    w.prod.pulse();
    expect(row(w.yard).stock).toEqual([]);
  });

  it('only kinds with blueprint recipes are tracked', () => {
    expect(tracksBlueprintStock('shipyard')).toBe(true);
    expect(tracksBlueprintStock('smelter')).toBe(false);
    expect(blueprintStockMask('shipyard', [])).toBe(0);
  });
});
