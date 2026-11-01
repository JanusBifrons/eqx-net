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
import { GOOD_DEFS, GOOD_IDS } from '../../shared-types/goods';

export interface SelectionStats {
  /** Echoes the entity id these stats are for, or null when none received. */
  id: string | null;
  name: string;
  hp: number;
  hpMax: number;
  /** Undefined for entities without a shield layer (structures). */
  shield: number | undefined;
  shieldMax: number | undefined;
  /** Living World P1a-2 — an OWNED storage structure's contents, flattened to
   *  PRIMITIVES so the panel's keyed shallow compare stays exact: a contents
   *  line ("Salvage 7 · ¢30"), weight use ("12/5000") and the salvage count
   *  (the Refine gate). Undefined / 0 for everything else (owner-only on wire). */
  holdLine: string | undefined;
  holdUse: string | undefined;
  holdSalvage: number;
  /** P5 — stored blueprint ids, comma-joined (a primitive for the shallow compare). */
  holdBlueprints: string;
  /** W5a — stored packed product ids, comma-joined (the Unpack chips). */
  holdPacked: string;
}

export const selectionStats: SelectionStats = {
  id: null,
  name: '',
  hp: 0,
  hpMax: 0,
  shield: undefined,
  shieldMax: undefined,
  holdLine: undefined,
  holdUse: undefined,
  holdSalvage: 0,
  holdBlueprints: '',
  holdPacked: '',
};

interface HoldWire {
  goods: Partial<Record<string, number>>;
  blueprints: number;
  blueprintIds?: string[];
  packed?: number;
  packedIds?: string[];
}

/** Apply a fresh `entity_stats` packet (mutated in place — no alloc on the
 *  common no-storage path; storage formatting runs at the ~5 Hz push only). */
export function applySelectionStats(s: {
  id: string;
  name: string;
  hp: number;
  hpMax: number;
  shield?: number;
  shieldMax?: number;
  hold?: HoldWire;
  holdCapacity?: number;
}): void {
  selectionStats.id = s.id;
  selectionStats.name = s.name;
  selectionStats.hp = s.hp;
  selectionStats.hpMax = s.hpMax;
  selectionStats.shield = s.shield;
  selectionStats.shieldMax = s.shieldMax;
  if (s.hold !== undefined && s.holdCapacity !== undefined) {
    selectionStats.holdLine = formatHoldLine(s.hold);
    selectionStats.holdUse = `${Math.round(holdViewWeight(s.hold))}/${s.holdCapacity}`;
    selectionStats.holdSalvage = s.hold.goods.salvage ?? 0;
    selectionStats.holdBlueprints = (s.hold.blueprintIds ?? []).join(',');
    selectionStats.holdPacked = (s.hold.packedIds ?? []).join(',');
  } else {
    selectionStats.holdLine = undefined;
    selectionStats.holdUse = undefined;
    selectionStats.holdSalvage = 0;
    selectionStats.holdBlueprints = '';
    selectionStats.holdPacked = '';
  }
}

/** Clear on deselect / selection change so the panel doesn't show stale data. */
export function resetSelectionStats(): void {
  selectionStats.id = null;
  selectionStats.name = '';
  selectionStats.hp = 0;
  selectionStats.hpMax = 0;
  selectionStats.shield = undefined;
  selectionStats.shieldMax = undefined;
  selectionStats.holdLine = undefined;
  selectionStats.holdUse = undefined;
  selectionStats.holdSalvage = 0;
  selectionStats.holdBlueprints = '';
  selectionStats.holdPacked = '';
}

/** "Salvage 7 · Alloy 3 · ¢30 · ★1" ("Empty" when nothing is stored). */
export function formatHoldLine(h: HoldWire): string {
  const parts: string[] = [];
  for (const id of GOOD_IDS) {
    const n = h.goods[id];
    if (n) parts.push(`${GOOD_DEFS[id].displayName} ${n}`);
  }
  if (h.blueprints > 0) parts.push(`★${h.blueprints}`);
  if ((h.packed ?? 0) > 0) parts.push(`▢${h.packed}`);
  return parts.length > 0 ? parts.join(' · ') : 'Empty';
}

function holdViewWeight(h: HoldWire): number {
  let w = 0;
  for (const id of GOOD_IDS) w += (h.goods[id] ?? 0) * GOOD_DEFS[id].weight;
  return w;
}
