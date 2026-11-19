/**
 * Gate post layout — the shield gate's and airlock's post sizes and post
 * centres, in the structure's GAME-local frame (y up, before rotation).
 *
 * Lives in shared-types (a leaf zone) so both the gate geometry in core
 * (`core/structures/gateGeometry.ts`: colliders, spans, `emitterAnchor`) and
 * the cable sockets (`structureSockets.ts`) read ONE copy of these numbers.
 */

/** Gate post size (the gate's footprint height). */
export const GATE_POST = 72;
/** Airlock corner-post size. */
export const AIRLOCK_POST = 64;
/** Shield gate width (post outer edge to post outer edge). */
export const GATE_W = 320;
/** Airlock width. */
export const AIRLOCK_W = 320;
/** Airlock depth (along local y, the travel axis). */
export const AIRLOCK_H = 260;

/** Airlock corner-post centre |x| and |y|. */
export const AIRLOCK_POST_X = AIRLOCK_W / 2 - AIRLOCK_POST / 2;
export const AIRLOCK_END_Y = AIRLOCK_H / 2 - AIRLOCK_POST / 2;

/** Shield gate post centres (left, right). */
export const GATE_POSTS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([-(GATE_W / 2 - GATE_POST / 2), 0] as const),
  Object.freeze([GATE_W / 2 - GATE_POST / 2, 0] as const),
]);

/** Airlock corner-post centres (A end +y: left, right; B end −y: left, right). */
export const AIRLOCK_POSTS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([-AIRLOCK_POST_X, AIRLOCK_END_Y] as const),
  Object.freeze([AIRLOCK_POST_X, AIRLOCK_END_Y] as const),
  Object.freeze([-AIRLOCK_POST_X, -AIRLOCK_END_Y] as const),
  Object.freeze([AIRLOCK_POST_X, -AIRLOCK_END_Y] as const),
]);
