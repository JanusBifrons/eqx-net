/**
 * Recipe queue (building panels B2) — a processor runs a MIXED list of
 * recipes, e.g. a Shipyard building interceptor, gunship, interceptor.
 *
 * Model: `rec.recipe` stays the HEAD (what runs now, so everything reading it is
 * unchanged); `rec.prodQueue` holds the entries after it. The queue reuses the
 * build count (`productionCount.ts`): in queue mode the head is ONE build
 * (`prodCount = 1`), so a completed cycle spends it to 0 and
 * `advanceRecipeQueue` pops the next entry into the head with a fresh count of
 * 1. With repeat on (`rec.prodQueueRepeat`) the finished head goes to the back
 * first, so the list loops. A drained queue (repeat off) leaves the last head
 * `done`, exactly like a used-up build count.
 *
 * The queue only ever moves `rec.recipe`: there is no second production path.
 * The head never changes while a cycle is loaded; advancing happens only once a
 * cycle's output is stored (nothing is loaded, so no `unload()` is needed).
 * Removing the HEAD goes through `ProductionSubsystem.setRecipe`, the same path
 * as `set_recipe`, so a loaded cycle hands its inputs back (refused if they
 * don't fit). `set_recipe` clears the queue.
 *
 * Not persisted or on the wire yet (later slices). A chunk recipe in a queue
 * holds its chunk when its one build is spent, as a build count does.
 */
import { MAX_RECIPE_QUEUE, isProcessorKind } from '../../shared-types/production.js';
import { RECIPES, type RecipeId } from '../../shared-types/recipes.js';
import type { ProductionSubsystem } from './ProductionSubsystem.js';
import type { StructureRecord } from './StructureRegistry.js';

/** One `edit_recipe_queue` request (schema-validated upstream). */
export interface RecipeQueueEdit {
  op: 'add' | 'remove' | 'repeat';
  recipe?: RecipeId | undefined;
  index?: number | undefined;
  on?: boolean | undefined;
}

/**
 * The head's one build is spent and nothing is loaded: move the next entry
 * into the head (repeat: the finished `head` goes to the back first). A no-op
 * outside queue mode, mid-cycle, or while the head still has its build left.
 * Alloc-free (push/shift on the existing array).
 */
export function advanceRecipeQueue(rec: StructureRecord, head: RecipeId): void {
  const q = rec.prodQueue;
  if (q === undefined || rec.prodCount !== 0 || rec.prodLoaded === true) return;
  if (rec.prodQueueRepeat === true) q.push(head);
  const next = q.shift();
  if (next === undefined) return; // drained, repeat off: stays done
  rec.recipe = next;
  rec.prodCount = 1;
}

/**
 * Apply one queue edit. Returns false (changing nothing) when refused: not a
 * processor, a recipe this kind can't run, over `MAX_RECIPE_QUEUE` (head
 * included), a bad index, or a head removal whose loaded inputs don't fit.
 */
export function editRecipeQueue(
  prod: Pick<ProductionSubsystem, 'setRecipe' | 'recipeOf'>,
  rec: StructureRecord,
  edit: RecipeQueueEdit,
): boolean {
  if (!isProcessorKind(rec.kind)) return false;
  if (edit.op === 'add') {
    if (edit.recipe === undefined || !RECIPES[edit.recipe].processors.includes(rec.kind)) return false;
    let q = rec.prodQueue;
    if (q !== undefined && q.length + 2 > MAX_RECIPE_QUEUE) return false;
    if (q === undefined) {
      // Entering queue mode: the head becomes one build (a done head stays done).
      q = rec.prodQueue = [];
      if (rec.prodCount !== 0) rec.prodCount = 1;
    }
    q.push(edit.recipe);
    advanceRecipeQueue(rec, prod.recipeOf(rec)); // a done head starts the new entry
    return true;
  }
  if (edit.op === 'repeat') {
    if (edit.on === undefined) return false;
    rec.prodQueueRepeat = edit.on;
    advanceRecipeQueue(rec, prod.recipeOf(rec)); // a drained queue loops again
    return true;
  }
  return removeEntry(prod, rec, edit.index);
}

function removeEntry(prod: Pick<ProductionSubsystem, 'setRecipe'>, rec: StructureRecord, index: number | undefined): boolean {
  const q = rec.prodQueue;
  if (q === undefined || index === undefined || index > q.length) return false;
  if (index === 0) {
    // The head: the next entry takes over through setRecipe (a loaded cycle
    // hands its inputs back first). The last entry can't be removed.
    const next = q[0];
    if (next === undefined || !prod.setRecipe(rec, next, 1)) return false;
    q.shift();
    rec.prodQueue = q; // setRecipe clears the queue; keep the rest
    return true;
  }
  for (let i = index - 1; i < q.length - 1; i++) q[i] = q[i + 1]!;
  q.length--;
  return true;
}
