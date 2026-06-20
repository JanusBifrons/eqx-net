/**
 * Pure helpers for the ship-upgrade modal's local allocation draft (Phase 4
 * WS-B2). Kept out of the React component so the spend/remaining/clamp logic is
 * unit-testable without a DOM (the Phase-A3 "decision logic is pure" rule). The
 * server is the authority — `isAllocValid` (core) re-gates every apply — so this
 * is UI affordance only, but it must agree with the server's budget so the modal
 * never offers a spend the server will silently drop.
 */

import { STAT_IDS, type StatId, type StatAlloc, pointBudget, spentPoints } from '../../core/leveling/shipStats.js';

export { STAT_IDS, type StatId };

/** Friendly labels for the stat pool, keyed by id (modal render order matches
 *  `STAT_IDS`). */
export const STAT_LABELS: Readonly<Record<StatId, string>> = Object.freeze({
  hull: 'Max Hull',
  energy: 'Energy',
  damage: 'Damage',
  topSpeed: 'Top Speed',
  turnRate: 'Turn Rate',
  shield: 'Shield',
});

/** Normalise a (possibly partial / wire) allocation into a full draft with a
 *  point count for EVERY stat id (0 where unspent). */
export function toDraft(alloc: StatAlloc | undefined): Record<StatId, number> {
  const out = {} as Record<StatId, number>;
  for (const id of STAT_IDS) {
    const n = alloc?.[id];
    out[id] = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return out;
}

/** Remaining (unspent) points for a draft at a given level. Never negative. */
export function remainingPoints(draft: Record<StatId, number>, level: number): number {
  const left = pointBudget(level) - spentPoints(draft);
  return left > 0 ? left : 0;
}

/**
 * Return a NEW draft with `delta` applied to `id`, clamped so:
 *   - the stat never drops below 0, AND
 *   - the total spend never exceeds the level budget (an increment past the
 *     budget is a no-op).
 * Pure — the caller owns the draft state.
 */
export function adjustDraft(
  draft: Record<StatId, number>,
  id: StatId,
  delta: number,
  level: number,
): Record<StatId, number> {
  const current = draft[id] ?? 0;
  let next = current + delta;
  if (next < 0) next = 0;
  // Reject an increment that would push the total over budget.
  if (delta > 0) {
    const budget = pointBudget(level);
    const others = spentPoints(draft) - current;
    if (others + next > budget) return draft; // no change
  }
  if (next === current) return draft;
  return { ...draft, [id]: next };
}

/** Strip the zeros so the wire payload (and the server's `statAlloc`) only
 *  carries spent stats — matches the `{}` = un-upgraded convention. */
export function draftToAlloc(draft: Record<StatId, number>): StatAlloc {
  const out: StatAlloc = {};
  for (const id of STAT_IDS) {
    const n = draft[id];
    if (n > 0) out[id] = n;
  }
  return out;
}
