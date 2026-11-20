/**
 * Job 2E — `set_recipe` carries an optional build count through to the
 * processor; the strict schema bounds it (1..99, whole numbers).
 */
import { describe, expect, it } from 'vitest';
import type { Client } from 'colyseus';
import { registerStructureSettingMessages, type StructureSettingMessageHost } from './structureSettingMessages.js';
import { SetRecipeSchema } from '../../../shared-types/messages.js';
import type { StructureRecord } from '../../structures/StructureRegistry.js';
import type { RecipeId } from '../../../shared-types/recipes.js';

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
