/**
 * Job 2E — `set_recipe` carries an optional build count through to the
 * processor; the strict schema bounds it (1..99, whole numbers).
 */
import { describe, expect, it } from 'vitest';
import type { Client } from 'colyseus';
import { registerStructureSettingMessages, type StructureSettingMessageHost } from './structureSettingMessages.js';
import { SetRecipeSchema } from '../../../shared-types/messages.js';
import type { StructureRecord } from '../../structures/StructureRegistry.js';
import { blueprintProductFor, type RecipeId } from '../../../shared-types/recipes.js';
import type { BlueprintItem } from '../../../shared-types/items.js';

function host() {
  const handlers = new Map<string, (c: Client, raw: unknown) => void>();
  const yard = { id: 'y', owner: 'alice', kind: 'shipyard' } as StructureRecord;
  const calls: Array<{ recipe: RecipeId; count: number | undefined }> = [];
  const h = {
    onMessage: (t: string, fn: (c: Client, raw: unknown) => void) => { handlers.set(t, fn); },
    malformed: { record: () => {} },
    sessionToPlayer: () => new Map([['s1', 'alice']]),
    swarmRegistry: { getByEntityId: (eid: number) => (eid === 7 ? { id: 'y' } : undefined) },
    structureRegistry: { get: (id: string) => (id === 'y' ? yard : undefined) },
    sectorKey: () => null,
    production: () => ({ setRecipe: (_r: StructureRecord, recipe: RecipeId, count?: number) => { calls.push({ recipe, count }); return true; } }),
    storage: () => ({ flushDirty: () => {}, refine: () => 0 }),
    rebuildStructuresSlice: () => {},
  } as unknown as StructureSettingMessageHost;
  registerStructureSettingMessages(h);
  const send = (raw: unknown) => handlers.get('set_recipe')!({ sessionId: 's1' } as Client, raw);
  return { send, calls };
}

describe('set_recipe build count (job 2E)', () => {
  it('passes the count through to the processor; no count stays undefined', () => {
    const { send, calls } = host();
    send({ type: 'set_recipe', entityId: 7, recipe: 'build_gunship', count: 3 });
    send({ type: 'set_recipe', entityId: 7, recipe: 'build_gunship' });
    expect(calls).toEqual([{ recipe: 'build_gunship', count: 3 }, { recipe: 'build_gunship', count: undefined }]);
  });

  it('the schema takes 1..99 whole numbers only', () => {
    const base = { type: 'set_recipe', entityId: 1, recipe: 'build_gunship' };
    expect(SetRecipeSchema.safeParse({ ...base, count: 1 }).success).toBe(true);
    expect(SetRecipeSchema.safeParse({ ...base, count: 99 }).success).toBe(true);
    for (const count of [0, 100, 1.5, -1, '3']) expect(SetRecipeSchema.safeParse({ ...base, count }).success).toBe(false);
  });
});

/** A yard holding `loaded`, storage holding `stored` (products); the storage
 *  mock moves blueprints the way `StorageService` does (load swaps, unload
 *  needs `room`). */
function yardWithBlueprints(loaded: string, stored: string[], room = true, held: string[] = []) {
  const handlers = new Map<string, (c: Client, raw: unknown) => void>();
  const bp = (product: string) => ({ uid: product, product, kind: 'bpc', runs: 5, material: 0, output: 0 }) as unknown as BlueprintItem;
  const yard = { id: 'y', owner: 'alice', kind: 'shipyard', recipe: 'build_interceptor', blueprint: bp(loaded) } as StructureRecord;
  const storage = stored.map(bp);
  const shipHold = held.map(bp);
  const h = {
    onMessage: (t: string, fn: (c: Client, raw: unknown) => void) => { handlers.set(t, fn); },
    malformed: { record: () => {} },
    sessionToPlayer: () => new Map([['s1', 'alice']]),
    swarmRegistry: { getByEntityId: (eid: number) => (eid === 7 ? { id: 'y' } : undefined) },
    structureRegistry: { get: (id: string) => (id === 'y' ? yard : undefined) },
    sectorKey: () => null,
    production: () => ({ setRecipe: (r: StructureRecord, recipe: RecipeId) => { r.recipe = recipe; return true; } }),
    storage: () => ({
      flushDirty: () => {},
      refine: () => 0,
      loadBlueprint: (p: StructureRecord, product: string, _q: unknown, shipUid?: string) => {
        // Storage first, else the owner's ship hold (only when its key is passed).
        let list = storage;
        let i = storage.findIndex((b) => b.product === product);
        if (i < 0 && shipUid === 'ship-a') { list = shipHold; i = shipHold.findIndex((b) => b.product === product); }
        if (i < 0) return false;
        const [b] = list.splice(i, 1);
        if (p.blueprint !== undefined) list.push(p.blueprint);
        p.blueprint = b;
        return true;
      },
      unloadBlueprint: (p: StructureRecord) => {
        if (!room || p.blueprint === undefined) return false;
        storage.push(p.blueprint);
        p.blueprint = undefined;
        return true;
      },
    }),
    rebuildStructuresSlice: () => {},
    ownShipKey: (pid: string) => (pid === 'alice' ? 'ship-a' : undefined),
  } as unknown as StructureSettingMessageHost;
  registerStructureSettingMessages(h);
  const send = (raw: unknown) => handlers.get('set_recipe')!({ sessionId: 's1' } as Client, raw);
  return { send, yard, storage, shipHold };
}

describe('set_recipe swaps a blueprint that no longer fits', () => {
  const skiff = blueprintProductFor('build_mining_skiff');
  const interceptor = blueprintProductFor('build_interceptor');

  it('Interceptor loaded, recipe -> Mining Skiff: the Skiff blueprint from storage is loaded, the Interceptor one goes back', () => {
    const { send, yard, storage } = yardWithBlueprints(interceptor, [skiff]);
    send({ type: 'set_recipe', entityId: 7, recipe: 'build_mining_skiff' });
    expect(yard.blueprint?.product).toBe(skiff);
    expect(storage.map((b) => b.product)).toEqual([interceptor]);
  });

  it('no matching blueprint in storage: the old one goes back to storage, slot empty', () => {
    const { send, yard, storage } = yardWithBlueprints(interceptor, []);
    send({ type: 'set_recipe', entityId: 7, recipe: 'build_mining_skiff' });
    expect(yard.blueprint).toBeUndefined();
    expect(storage.map((b) => b.product)).toEqual([interceptor]);
  });

  it('only the ship hold has a Skiff blueprint: it is loaded from the hold (same path as a manual Load)', () => {
    const { send, yard, storage, shipHold } = yardWithBlueprints(interceptor, [], true, [skiff]);
    send({ type: 'set_recipe', entityId: 7, recipe: 'build_mining_skiff' });
    expect(yard.blueprint?.product).toBe(skiff);
    expect(shipHold.map((b) => b.product)).toEqual([interceptor]);
    expect(storage).toHaveLength(0);
  });

  it('storage cannot take it back: the old one stays loaded', () => {
    const { send, yard } = yardWithBlueprints(interceptor, [], false);
    send({ type: 'set_recipe', entityId: 7, recipe: 'build_mining_skiff' });
    expect(yard.blueprint?.product).toBe(interceptor);
  });

  it('a blueprint that still fits stays put', () => {
    const { send, yard, storage } = yardWithBlueprints(interceptor, [interceptor]);
    send({ type: 'set_recipe', entityId: 7, recipe: 'build_interceptor' });
    expect(yard.blueprint?.uid).toBe(interceptor);
    expect(storage).toHaveLength(1);
  });
});
