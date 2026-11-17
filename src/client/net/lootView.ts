/**
 * Living World P1a — pure client helpers for the cargo HUD (unit-locked).
 * No React, no Pixi: the chip and the snapshot path both call these.
 */
import { GOOD_DEFS, GOOD_IDS } from '../../shared-types/goods';
import { productName } from '../../shared-types/blueprints';
import { ROCK_CHUNK_PRODUCT, type PackedItem } from '../../shared-types/items';
import { packedItemWeight } from '../../core/cargo/hold';
import type { CargoView } from '../state/storeTypes';

/** The own-ship snapshot's hold slice, as the client reads it. */
export interface WireCargo { goods: Partial<Record<string, number>>; blueprints: readonly unknown[]; packed?: readonly PackedItem[] }

/** Total weight of the packed items (alloc-free). */
function packedWeightOf(packed: readonly PackedItem[] | undefined): number {
  let w = 0;
  if (packed) for (let i = 0; i < packed.length; i++) w += packedItemWeight(packed[i]!);
  return w;
}

/** The HUD view of a wire hold (written to the store only on change). */
export function cargoViewOf(c: WireCargo): CargoView {
  return { goods: { ...c.goods }, blueprints: c.blueprints.length, packed: c.packed?.length ?? 0, packedWeight: packedWeightOf(c.packed) };
}

/** How long a pickup popup stays on screen. */
export const LOOT_FEED_TTL_MS = 2_500;

/** "+7 Salvage · +1 blueprint" (empty string when nothing moved). Credits are
 *  never picked up — they're virtual (economy v2 W1). */
export function formatLootPickup(e: { goods: Partial<Record<string, number>>; blueprints: number; packed?: readonly string[] }): string {
  const parts: string[] = [];
  for (const id of GOOD_IDS) {
    const n = e.goods[id];
    if (n) parts.push(`+${n} ${GOOD_DEFS[id].displayName}`);
  }
  if (e.blueprints > 0) parts.push(`+${e.blueprints} blueprint${e.blueprints === 1 ? '' : 's'}`);
  // Economy v2 W4a — packed structures/hulls, by name ("+Packed Smelter").
  // A rock chunk goes in whole, its ore unknown until refined.
  for (const p of e.packed ?? []) parts.push(p === ROCK_CHUNK_PRODUCT ? '+Rock chunk' : `+Packed ${productName(p)}`);
  return parts.join(' · ');
}

/** Field-by-field compare of the stored view against an incoming wire hold —
 *  alloc-free, so the per-snapshot call is cheap (#14). */
export function cargoChanged(
  prev: CargoView | null,
  next: WireCargo | undefined,
): boolean {
  if (prev === null || next === undefined) return (prev === null) !== (next === undefined);
  if (prev.blueprints !== next.blueprints.length || (prev.packed ?? 0) !== (next.packed?.length ?? 0)) return true;
  if ((prev.packedWeight ?? 0) !== packedWeightOf(next.packed)) return true;
  for (const id of GOOD_IDS) {
    if ((prev.goods[id] ?? 0) !== (next.goods[id] ?? 0)) return true;
  }
  return false;
}

/** Cargo weight of the HUD view (blueprints are weightless; packed items,
 *  rock chunks included, count their weight). */
export function cargoWeight(c: CargoView | null): number {
  if (c === null) return 0;
  let w = c.packedWeight ?? 0;
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
