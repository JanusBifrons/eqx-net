/**
 * Phase 4 WS-A1 — spectator-mode pure decisions.
 *
 * Spectator (locked decisions D3/D4/D5) is a CLIENT-LOCAL, un-networked,
 * invulnerable free-roam construction camera. On the local ship's death the
 * client flips into spectator INSTANTLY (no death modal); a deliberate
 * pilot↔spectator speed-dial toggle also drives it. The free-roam camera pose
 * lives in the render mirror / `Camera`, never the store — only the discrete
 * `pilotMode` enum is in Zustand (Invariant #2).
 *
 * These two helpers carry the decisions the live client wiring composes, so
 * the active-ship gate removal + the death transition are unit-lockable
 * without a renderer or live room.
 */

import type { PilotMode } from '../state/storeTypes.js';

/**
 * True when the DESTROYED entity is the LOCAL player's ship — the only case
 * that flips the client into spectator. A remote ship dying (or a death seen
 * before the local id is known) never changes the local pilot mode.
 */
export function shouldEnterSpectatorOnDeath(
  destroyedEntityId: string,
  localPlayerId: string | null,
): boolean {
  return localPlayerId !== null && destroyedEntityId === localPlayerId;
}

/** The discrete mode the camera / input / placement branches gate on. */
export function isSpectating(mode: PilotMode): boolean {
  return mode === 'spectator';
}
