/**
 * Loot window search (plan cargo-pods slice 12): a container's stacks reveal
 * one at a time, in grid order, each taking a time set by its rarity. Pure:
 * the server owns the elapsed search time per (viewer, container) and sends
 * only what this returns as revealed, so the client never sees a hidden stack.
 */
import { GOOD_DEFS, GOOD_IDS, type Hold } from '../../shared-types/goods.js';
import { emptyHold, extractRequested, cloneHold, type CargoRequest } from './hold.js';

/** Search time per stack by rarity tier (0 common, 1 rare, 2 top / blueprint
 *  / packed item). Owner 2026-11-17: ~0.5 / 1 / 2 s. Game time. */
export const REVEAL_MS: readonly [number, number, number] = [500, 1000, 2000];

export interface SearchView {
  /** The stacks found so far (a sub-hold of the container). */
  revealed: Hold;
  /** Stacks still hidden ("?" tiles). */
  hidden: number;
  /** Search time until the next stack shows; 0 when nothing is hidden. */
  nextInMs: number;
}

/**
 * What `elapsedMs` of searching has found in `h`. Grid order: goods in
 * catalogue order, then blueprints, then packed items. A stack taken out
 * shortens the queue, so a found stack never hides again on its own.
 */
export function searchView(h: Hold, elapsedMs: number): SearchView {
  const revealed = emptyHold();
  let t = 0;
  let hidden = 0;
  let nextInMs = 0;
  const step = (tier: 0 | 1 | 2): boolean => {
    t += REVEAL_MS[tier];
    if (t <= elapsedMs) return true;
    if (hidden === 0) nextInMs = t - elapsedMs;
    hidden++;
    return false;
  };
  for (const id of GOOD_IDS) {
    const n = h.goods[id] ?? 0;
    if (n > 0 && step(GOOD_DEFS[id].tier)) revealed.goods[id] = n;
  }
  for (const b of h.blueprints) if (step(2)) revealed.blueprints.push({ ...b });
  if (h.packed) {
    for (const p of h.packed) if (step(2)) (revealed.packed ??= []).push({ ...p });
  }
  return { revealed, hidden, nextInMs };
}

/** Does `want` ask for nothing at all? */
export function isRequestEmpty(want: CargoRequest): boolean {
  if ((want.blueprints?.length ?? 0) > 0 || (want.packed?.length ?? 0) > 0) return false;
  for (const id of GOOD_IDS) if ((want.goods?.[id] ?? 0) > 0) return false;
  return true;
}

/** `want` cut down to what is in `from` (only found stacks can be taken). */
export function clampRequest(from: Hold, want: CargoRequest): CargoRequest {
  const got = extractRequested(cloneHold(from), want);
  const out: CargoRequest = { goods: got.goods };
  if (got.blueprints.length > 0) out.blueprints = got.blueprints.map((b) => b.uid);
  if (got.packed && got.packed.length > 0) out.packed = got.packed.map((p) => p.product);
  return out;
}
