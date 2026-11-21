/**
 * Building panels B2 — client → server: edit a processor's recipe queue (a
 * Shipyard's mixed hull list, e.g. interceptor, gunship, interceptor).
 * Sits beside `SetRecipeSchema` (`clientMessages.ts`, at its line cap) and,
 * like `set_freight_orders`, is parsed by its own handler rather than the
 * `ClientMessageSchema` union.
 *
 * - `add`: append `recipe` (the kind must run it; at most `MAX_RECIPE_QUEUE`
 *   entries counting the head);
 * - `remove`: drop entry `index` (0 = the head: a loaded cycle hands its
 *   inputs back first, refused if they don't fit);
 * - `repeat`: loop the list `on` / off.
 * Same owner / kind gate as `set_recipe`; a refused edit is a silent no-op.
 * `set_recipe` clears the queue. Strict.
 */
import { z } from 'zod';
import { RECIPE_IDS } from '../recipes.js';
import { MAX_RECIPE_QUEUE } from '../production.js';

export const EditRecipeQueueSchema = z
  .object({
    type: z.literal('edit_recipe_queue'),
    entityId: z.number().int().nonnegative(),
    op: z.enum(['add', 'remove', 'repeat']),
    recipe: z.enum(RECIPE_IDS).optional(),
    index: z.number().int().min(0).max(MAX_RECIPE_QUEUE - 1).optional(),
    on: z.boolean().optional(),
  })
  .strict();

export type EditRecipeQueueMessage = z.infer<typeof EditRecipeQueueSchema>;
