/**
 * Living World P1a — pure client helpers for the cargo HUD (unit-locked).
 * No React, no Pixi: the chip and the snapshot path both call these.
 */
import { GOOD_DEFS, GOOD_IDS } from '../../shared-types/goods';
import type { CargoView } from '../state/storeTypes';

/** How long a pickup popup stays on screen. */
export const LOOT_FEED_TTL_MS = 2_500;

/** "+7 Salvage · +30 cr · +1 blueprint" (empty string when nothing moved). */
export function formatLootPickup(e: { goods: Partial<Record<string, number>>; credits: number; blueprints: number }): string {
  const parts: string[] = [];
  for (const id of GOOD_IDS) {
    const n = e.goods[id];
    if (n) parts.push(`+${n} ${GOOD_DEFS[id].displayName}`);
  }
  if (e.credits > 0) parts.push(`+${e.credits} cr`);
  if (e.blueprints > 0) parts.push(`+${e.blueprints} blueprint${e.blueprints === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** Field-by-field compare of the stored view against an incoming wire hold —
 *  alloc-free, so the per-snapshot call is cheap (#14). */
export function cargoChanged(
  prev: CargoView | null,
  next: { goods: Partial<Record<string, number>>; credits: number; blueprints: string[] } | undefined,
): boolean {
  if (prev === null || next === undefined) return (prev === null) !== (next === undefined);
  if (prev.credits !== next.credits || prev.blueprints !== next.blueprints.length) return true;
  for (const id of GOOD_IDS) {
    if ((prev.goods[id] ?? 0) !== (next.goods[id] ?? 0)) return true;
  }
  return false;
}

/** Cargo weight of the HUD view (credits + blueprints are weightless). */
export function cargoWeight(c: CargoView | null): number {
  if (c === null) return 0;
  let w = 0;
  for (const id of GOOD_IDS) w += (c.goods[id] ?? 0) * GOOD_DEFS[id].weight;
  return w;
}

/** Chip fill state: amber at 80 %, red when full. */
export function cargoFillState(weight: number, capacity: number): 'ok' | 'high' | 'full' {
  if (capacity <= 0) return 'ok';
  const f = weight / capacity;
  if (f >= 0.999) return 'full';
  if (f >= 0.8) return 'high';
  return 'ok';
}
