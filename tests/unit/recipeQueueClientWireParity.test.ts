/**
 * Client → server wire parity (#15) for the recipe-queue sender in
 * `src/client/structures/structureActionsClient.ts`: the exact payload each
 * op puts on the wire must pass the strict server schema.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../../src/client/structures/structureActionsClient';
import { EditRecipeQueueSchema } from '../../src/shared-types/messages';
import { MAX_RECIPE_QUEUE } from '../../src/shared-types/production';

const sent: Array<{ type: string; payload: unknown }> = [];
vi.mock('../../src/client/net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send: (type: string, payload: unknown) => sent.push({ type, payload }) }) }),
}));
vi.mock('../../src/client/net/clientSingleton.js', () => ({
  getGameClient: () => ({ getRoom: () => ({ send: (type: string, payload: unknown) => sent.push({ type, payload }) }) }),
}));

function lastAccepted(): void {
  const m = sent[sent.length - 1]!;
  expect(m.type).toBe('edit_recipe_queue');
  const r = EditRecipeQueueSchema.safeParse(m.payload);
  expect(r.success, `${JSON.stringify(m.payload)} → ${r.success ? '' : r.error.message}`).toBe(true);
}

describe('recipe queue sender matches the server schema', () => {
  afterEach(() => { sent.length = 0; });

  it('add, remove (head and last index) and repeat on / off', () => {
    client.sendEditRecipeQueue(7, { op: 'add', recipe: 'build_gunship' });
    lastAccepted();
    client.sendEditRecipeQueue(7, { op: 'remove', index: 0 });
    lastAccepted();
    client.sendEditRecipeQueue(7, { op: 'remove', index: MAX_RECIPE_QUEUE - 1 });
    lastAccepted();
    client.sendEditRecipeQueue(7, { op: 'repeat', on: true });
    lastAccepted();
    client.sendEditRecipeQueue(7, { op: 'repeat', on: false });
    lastAccepted();
    expect(sent).toHaveLength(5);
  });
});
