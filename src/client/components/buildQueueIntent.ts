/**
 * What a tap on the Build tab's hull tiles sends, as pure decisions. Today a
 * processor holds ONE recipe and a build count (`set_recipe` + `count`, count
 * 1..MAX_BUILD_COUNT, absent = forever), so the "queue" is that recipe times
 * its count: a different hull replaces it (after a confirm). When the server
 * queue lands, only this file changes.
 */
import { MAX_BUILD_COUNT } from '@shared-types/production';
import type { RecipeId } from '@shared-types/recipes';
import { sendSetRecipe } from '../structures/structureActionsClient';

/** The queue as the tiles see it: the recipe and builds left (undefined = forever). */
export interface QueueNow { recipe: RecipeId; left: number | undefined }

export type QueueIntent =
  | { kind: 'send'; recipe: RecipeId; count: number | undefined }
  /** A different hull: ask first, it replaces the queue. */
  | { kind: 'confirm'; recipe: RecipeId; count: number }
  | null;

/** Tap (+1) or hold (+5) on a tile. The current hull adds to its count (a
 *  forever queue is already endless); a different hull asks to switch. */
export function addIntent(q: QueueNow, recipe: RecipeId, add: number): QueueIntent {
  if (recipe !== q.recipe) return { kind: 'confirm', recipe, count: Math.min(MAX_BUILD_COUNT, add) };
  if (q.left === undefined) return null;
  const next = Math.min(MAX_BUILD_COUNT, q.left + add);
  return next === q.left ? null : { kind: 'send', recipe, count: next };
}

/** Tap on the queue's head: one fewer. The wire has no count 0, so it stops at 1. */
export function removeOneIntent(q: QueueNow): QueueIntent {
  if (q.left === undefined || q.left <= 1) return null;
  return { kind: 'send', recipe: q.recipe, count: q.left - 1 };
}

/** The ∞ toggle: forever on (count cleared), or off (back to one build). */
export function foreverIntent(q: QueueNow): QueueIntent {
  return { kind: 'send', recipe: q.recipe, count: q.left === undefined ? 1 : undefined };
}

/** Send a decided intent (`confirm` is sent only once the owner agrees). */
export function sendQueueIntent(entityId: number, intent: QueueIntent): void {
  if (intent === null) return;
  sendSetRecipe(entityId, intent.recipe, intent.count);
}
