/**
 * Production channel for the live stats of the currently-selected entity
 * (structures follow-up Item B5).
 *
 * WHY A MODULE SINGLETON (mirrors `structures/placementChosen.ts`): the server
 * pushes `entity_stats` at ~5 Hz while an entity is selected. Routing those
 * numbers through Zustand would trigger a React re-render 5×/sec. Instead the
 * `entity_stats` handler mutates THIS singleton in place, and the
 * `EntityStatsPanel` POLLS it (every 150 ms, committing a re-render only on
 * change) for the numbers. Only the discrete
 * `selectedEntityId` lives in Zustand (panel visibility) — invariant #2: the
 * id is a discrete string, and hp/shield are non-spatial scalars.
 *
 * `id` echoes the selected entity id so the panel can ignore a stats packet
 * that arrived for a just-changed selection (it renders `--` until the matching
 * id arrives).
 */
export interface SelectionStats {
  /** Echoes the entity id these stats are for, or null when none received. */
  id: string | null;
  name: string;
  hp: number;
  hpMax: number;
  /** Undefined for entities without a shield layer (structures). */
  shield: number | undefined;
  shieldMax: number | undefined;
}

export const selectionStats: SelectionStats = {
  id: null,
  name: '',
  hp: 0,
  hpMax: 0,
  shield: undefined,
  shieldMax: undefined,
};

/** Apply a fresh `entity_stats` packet (mutated in place — no alloc). */
export function applySelectionStats(s: {
  id: string;
  name: string;
  hp: number;
  hpMax: number;
  shield?: number;
  shieldMax?: number;
}): void {
  selectionStats.id = s.id;
  selectionStats.name = s.name;
  selectionStats.hp = s.hp;
  selectionStats.hpMax = s.hpMax;
  selectionStats.shield = s.shield;
  selectionStats.shieldMax = s.shieldMax;
}

/** Clear on deselect / selection change so the panel doesn't show stale data. */
export function resetSelectionStats(): void {
  selectionStats.id = null;
  selectionStats.name = '';
  selectionStats.hp = 0;
  selectionStats.hpMax = 0;
  selectionStats.shield = undefined;
  selectionStats.shieldMax = undefined;
}
