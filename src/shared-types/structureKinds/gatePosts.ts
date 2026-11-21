/**
 * Gate post layout — the shield gate's and airlock's post sizes and post
 * centres, in the structure's GAME-local frame (y up, before rotation).
 *
 * Lives in shared-types (a leaf zone) so both the gate geometry in core
 * (`core/structures/gateGeometry.ts`: colliders, spans, `emitterAnchor`) and
 * the cable sockets (`structureSockets.ts`) read ONE copy of these numbers.
 *
 * Structure restyle F2 (owner wireframe 2026-11-20): the towers grew wider
 * (gate 72 → 120, airlock side blocks 64 → 100) while the opening ships fly
 * through and the depths stayed as they were.
 */

/** Shield gate tower width (local x, across the gate). */
export const GATE_POST_W = 120;
/** Shield gate depth (local y, the travel axis): the tower depth and the
 *  gate's footprint height. */
export const GATE_DEPTH = 72;
/** Shield gate opening (between the towers) — the gap ships fly through. */
export const GATE_OPENING = 176;
/** Airlock side-block width (local x). */
export const AIRLOCK_POST_W = 100;
/** Airlock corner-post depth (local y, the travel axis). */
export const AIRLOCK_POST_D = 64;
/** Airlock opening (between the side blocks). */
export const AIRLOCK_OPENING = 192;
/** Shield gate width (tower outer edge to tower outer edge). */
export const GATE_W = 2 * GATE_POST_W + GATE_OPENING;
/** Airlock width. */
export const AIRLOCK_W = 2 * AIRLOCK_POST_W + AIRLOCK_OPENING;
/** Airlock depth (along local y, the travel axis). */
export const AIRLOCK_H = 260;

/** Airlock corner-post centre |x| and |y|. */
export const AIRLOCK_POST_X = AIRLOCK_W / 2 - AIRLOCK_POST_W / 2;
export const AIRLOCK_END_Y = AIRLOCK_H / 2 - AIRLOCK_POST_D / 2;

/** Shield gate post centres (left, right). */
export const GATE_POSTS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([-(GATE_W / 2 - GATE_POST_W / 2), 0] as const),
  Object.freeze([GATE_W / 2 - GATE_POST_W / 2, 0] as const),
]);

/** Airlock corner-post centres (A end +y: left, right; B end −y: left, right). */
export const AIRLOCK_POSTS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([-AIRLOCK_POST_X, AIRLOCK_END_Y] as const),
  Object.freeze([AIRLOCK_POST_X, AIRLOCK_END_Y] as const),
  Object.freeze([-AIRLOCK_POST_X, -AIRLOCK_END_Y] as const),
  Object.freeze([AIRLOCK_POST_X, -AIRLOCK_END_Y] as const),
]);
