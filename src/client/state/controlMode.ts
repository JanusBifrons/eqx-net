import type { ControlMode, UIStore } from './storeTypes.js';

/**
 * The player-facing control mode derived from the stored `pilotMode` +
 * `buildMode` (see `ControlMode`). A pure selector, so the names never drift.
 * Store-free (re-exported from `store.ts`) so pure helpers can use it without
 * pulling in the store.
 */
export function selectControlMode(s: Pick<UIStore, 'pilotMode' | 'buildMode'> & Partial<Pick<UIStore, 'pendingCommandStart'>>): ControlMode {
  return s.buildMode ? 'build' : s.pilotMode === 'spectator' || s.pendingCommandStart === true ? 'command' : 'fly';
}
