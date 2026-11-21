/**
 * `load_blueprint` — the processor slot is filled from the owner's base
 * storage first, else from the owner's own ship hold (where a fresh pilot's
 * starter junk copies sit). Real StorageService + HoldStore, fake room host.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'colyseus';
import { registerBlueprintMessages, type BlueprintMessageHost } from './blueprintMessages.js';
import { StorageService } from '../../cargo/StorageService.js';
import { structureUid } from '../../cargo/storageHolds.js';
import { HoldStore } from '../../cargo/HoldStore.js';
import { StructureRegistry, type StructureRecord } from '../../structures/StructureRegistry.js';
import { structureKindToIndex, type StructureKindId } from '../../../shared-types/structureKinds.js';
import type { IPersistenceSink, PersistOp } from '../../../core/contracts/IPersistenceSink.js';
import type { BlueprintItem } from '../../../shared-types/items.js';
import { blueprintProductFor, type RecipeId } from '../../../shared-types/recipes.js';

// The handlers file imports the DB worker module (node:sqlite); these tests never touch it.
vi.mock('../../db/PersistenceWorker.js', () => ({ getHoldStore: () => null, getWallet: () => null }));

const RECIPE: RecipeId = 'build_mining_skiff';
const PRODUCT = blueprintProductFor(RECIPE);

function rec(id: string, kind: StructureKindId, x: number, y: number, over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, owner: 'p1', kind, subtypeIndex: structureKindToIndex(kind), x, y, radius: 20,
    isConstructed: true, constructionProgress: 0, constructionCost: 0, isDeconstructing: false,
    minerals: 0, storedPower: 0, level: 1, uid: structureUid('s', 'p1', kind, x, y), ...over,
  };
}

function bpc(uid: string, output: number, product = PRODUCT): BlueprintItem {
  return { uid, product, kind: 'bpc', runs: 2, material: 0, output, research: 0 };
}

function setup() {
  const ops: PersistOp[] = [];
  const sink: IPersistenceSink = {
    enqueueCritical: (op) => { ops.push(op); }, enqueueVolatile: () => {},
    enqueueCriticalAwaitable: () => Promise.resolve({}), shutdown: () => Promise.resolve({ drained: 0 }),
  };
  const holdStore = new HoldStore({ persistence: () => sink });
  const registry = new StructureRegistry();
  const component = ['cap', 'yard'];
  const svc = new StorageService({ holdStore, registry, sectorKey: () => 's', componentOf: (id) => (component.includes(id) ? component : [id]) });
  const yard = rec('yard', 'shipyard', 0, -400);
  registry.add(yard);
  const handlers = new Map<string, (client: Client, raw: unknown) => void>();
  let rebuilt = 0;
  const host = {
    onMessage: (type: string, fn: (client: Client, raw: unknown) => void) => { handlers.set(type, fn); },
    malformed: { record: () => {} },
    sessionToPlayer: () => new Map([['sess-1', 'p1']]),
    swarmRegistry: { getByEntityId: (eid: number) => (eid === 7 ? { id: 'yard' } : undefined) },
    structureRegistry: registry,
    production: () => ({ unload: () => true, recipeOf: () => RECIPE }),
    storage: () => svc,
    rebuildStructuresSlice: () => { rebuilt++; },
    ownShipKey: (pid: string) => (pid === 'p1' ? 'ship-1' : undefined),
  } as unknown as BlueprintMessageHost;
  registerBlueprintMessages(host);
  const load = () => handlers.get('load_blueprint')!({ sessionId: 'sess-1' } as Client, { type: 'load_blueprint', entityId: 7 });
  const shipHold = (blueprints: BlueprintItem[]) => holdStore.put({
    holderUid: 'ship-1', holderType: 'ship', ownerId: 'p1', sectorKey: null, x: null, y: null, hold: { goods: { alloy: 3 }, blueprints }, expiresAt: null,
  });
  return { svc, holdStore, registry, yard, load, shipHold, ops, rebuilt: () => rebuilt };
}

describe('load_blueprint — ship-hold fallback', () => {
  it('loads the best matching copy from my own ship hold when base storage has none', () => {
    const t = setup();
    t.registry.add(rec('cap', 'capital', 0, 0));
    t.shipHold([bpc('junk-lo', 1), bpc('junk-hi', 9), bpc('other', 50, 'recipe:x')]);
    t.ops.length = 0;
    t.load();
    expect(t.yard.blueprint?.uid).toBe('junk-hi');
    const left = t.holdStore.get('ship-1')!.hold;
    expect(left.blueprints.map((b) => b.uid).sort()).toEqual(['junk-lo', 'other']);
    expect(left.goods.alloy).toBe(3);
    expect(t.holdStore.get(`bpslot:${t.yard.uid}`)!.hold.blueprints[0]!.uid).toBe('junk-hi');
    // Slot + ship hold land in ONE atomic group (the first op; flushDirty follows).
    expect(t.ops[0]).toMatchObject({ type: 'GROUP' });
    expect((t.ops[0] as { ops: { holderUid?: string }[] }).ops.map((o) => o.holderUid).sort()).toEqual([`bpslot:${t.yard.uid}`, 'ship-1'].sort());
    expect(t.rebuilt()).toBe(1);
  });

  it('base storage still wins when it holds a matching blueprint', () => {
    const t = setup();
    t.registry.add(rec('cap', 'capital', 0, 0, { hold: { goods: {}, blueprints: [bpc('base', 1)] } }));
    t.shipHold([bpc('ship', 9)]);
    t.load();
    expect(t.yard.blueprint?.uid).toBe('base');
    expect(t.holdStore.get('ship-1')!.hold.blueprints.map((b) => b.uid)).toEqual(['ship']);
  });

  it('a blueprint already in the slot goes into the ship hold it came from', () => {
    const t = setup();
    t.yard.blueprint = bpc('old', 0);
    t.shipHold([bpc('new', 5)]);
    t.load();
    expect(t.yard.blueprint?.uid).toBe('new');
    expect(t.holdStore.get('ship-1')!.hold.blueprints.map((b) => b.uid)).toEqual(['old']);
  });

  it('nothing changes when neither storage nor my hold has a matching copy', () => {
    const t = setup();
    t.shipHold([bpc('other', 5, 'recipe:x')]);
    t.load();
    expect(t.yard.blueprint).toBeUndefined();
    expect(t.rebuilt()).toBe(0);
  });
});
