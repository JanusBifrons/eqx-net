/**
 * Pure hold arithmetic (plan peppy-jumping-pinwheel P1a-1). Zone-blind, no I/O.
 *
 * Every movement of value in the game — pickup, deposit, spill-on-death,
 * salvage, trade escrow — is a `transferInto(dst, src, capacity)`: value only
 * ever MOVES between holds, it is never copied. That single primitive is what
 * the anti-duplication persistence (one atomic group per transfer) relies on.
 */
import { GOOD_DEFS, GOOD_IDS, type GoodId, type Hold } from '../../shared-types/goods.js';
import type { PackedItem } from '../../shared-types/items.js';
import { getStructureKind, isStructureKindId } from '../../shared-types/structureKinds.js';

/** Default cargo weight of a packed structure / hull when the catalogue has no
 *  `packedWeight` (the structures agent's field; the catalogue value wins). */
export const DEFAULT_PACKED_STRUCTURE_WEIGHT = 25;
export const DEFAULT_PACKED_HULL_WEIGHT = 40;

/** Cargo weight of ONE packed item. Shared by the HUD + the server clamp (#15). */
export function packedWeightOf(product: string): number {
  if (product.startsWith('structure:')) {
    const id = product.slice('structure:'.length);
    if (isStructureKindId(id)) {
      const w = (getStructureKind(id) as { packedWeight?: number }).packedWeight;
      if (typeof w === 'number' && w >= 0) return w;
    }
    return DEFAULT_PACKED_STRUCTURE_WEIGHT;
  }
  return DEFAULT_PACKED_HULL_WEIGHT;
}

/** Add one packed item (the production pass / a test seed). Mutates. */
export function addPacked(h: Hold, product: string, quality: number): void {
  (h.packed ??= []).push({ product, quality: Math.max(0, Math.min(100, Math.round(quality))) });
}

/** Take the best-quality packed `product` out of `h` (placement / unpack), or
 *  null when there is none. Mutates. */
export function takePacked(h: Hold, product: string): PackedItem | null {
  const list = h.packed;
  if (!list) return null;
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.product === product && (best < 0 || list[i]!.quality > list[best]!.quality)) best = i;
  }
  if (best < 0) return null;
  const [item] = list.splice(best, 1);
  if (list.length === 0) delete h.packed;
  return item!;
}

/** How many packed `product` items `h` holds. */
export function packedCount(h: Hold, product: string): number {
  let n = 0;
  for (const p of h.packed ?? []) if (p.product === product) n++;
  return n;
}

export function emptyHold(): Hold {
  return { goods: {}, blueprints: [] };
}

export function cloneHold(h: Hold): Hold {
  const c: Hold = { goods: { ...h.goods }, blueprints: h.blueprints.map((b) => ({ ...b })) };
  if (h.packed && h.packed.length > 0) c.packed = h.packed.map((p) => ({ ...p }));
  return c;
}

/** Total cargo weight (blueprints weigh nothing; credits are not cargo;
 *  packed structures / hulls are heavy). */
export function holdWeight(h: Hold): number {
  let w = 0;
  for (const id of GOOD_IDS) {
    const n = h.goods[id];
    if (n) w += n * GOOD_DEFS[id].weight;
  }
  if (h.packed) for (const p of h.packed) w += packedWeightOf(p.product);
  return w;
}

export function isHoldEmpty(h: Hold): boolean {
  if (h.blueprints.length > 0 || (h.packed?.length ?? 0) > 0) return false;
  for (const id of GOOD_IDS) if ((h.goods[id] ?? 0) > 0) return false;
  return true;
}

/** Highest rarity tier present (0 when only tier-0 goods). A
 *  blueprint counts as top tier. Drives loot-pod glow. */
export function holdBestTier(h: Hold): 0 | 1 | 2 {
  if (h.blueprints.length > 0 || (h.packed?.length ?? 0) > 0) return 2;
  let best: 0 | 1 | 2 = 0;
  for (const id of GOOD_IDS) {
    if ((h.goods[id] ?? 0) > 0 && GOOD_DEFS[id].tier > best) best = GOOD_DEFS[id].tier;
  }
  return best;
}

/** Result of a transfer — what actually moved (for audit / pickup popups). */
export interface TransferResult {
  moved: Hold;
  /** True when `src` is empty afterwards. */
  srcEmptied: boolean;
}

/**
 * Move as much of `src` into `dst` as `dstCapacity` (weight) allows.
 * Blueprints always move (weightless). Goods move highest-tier first so a
 * nearly-full hold keeps the valuable stuff. Mutates BOTH holds; value is
 * conserved exactly (dst gains what src loses). `dstCapacity = Infinity` ⇒
 * move everything.
 */
export function transferInto(dst: Hold, src: Hold, dstCapacity: number): TransferResult {
  const moved = emptyHold();
  if (src.blueprints.length > 0) {
    for (const b of src.blueprints) {
      dst.blueprints.push(b);
      moved.blueprints.push(b);
    }
    src.blueprints.length = 0;
  }
  let room = dstCapacity - holdWeight(dst);
  // Packed items are discrete and heavy: each moves whole if it fits.
  if (src.packed && src.packed.length > 0) {
    const keep: PackedItem[] = [];
    for (const p of src.packed) {
      const w = packedWeightOf(p.product);
      if (w <= room + 1e-9) {
        (dst.packed ??= []).push(p);
        (moved.packed ??= []).push(p);
        room -= w;
      } else {
        keep.push(p);
      }
    }
    if (keep.length > 0) src.packed = keep;
    else delete src.packed;
  }
  // Highest tier first.
  const order: GoodId[] = [...GOOD_IDS].sort((a, b) => GOOD_DEFS[b].tier - GOOD_DEFS[a].tier);
  for (const id of order) {
    const have = src.goods[id] ?? 0;
    if (have <= 0) continue;
    const w = GOOD_DEFS[id].weight;
    const fit = w <= 0 ? have : Math.min(have, Math.floor((room + 1e-9) / w));
    if (fit <= 0) continue;
    dst.goods[id] = (dst.goods[id] ?? 0) + fit;
    moved.goods[id] = fit;
    const left = have - fit;
    if (left > 0) src.goods[id] = left;
    else delete src.goods[id];
    room -= fit * w;
  }
  return { moved, srcEmptied: isHoldEmpty(src) };
}

/** Move a bounded AMOUNT of weight (salvage-over-time, P1a-2). Same rules as
 *  `transferInto` with the per-step budget as the capacity limit. */
export function transferUpTo(dst: Hold, src: Hold, dstCapacity: number, stepWeight: number): TransferResult {
  const cap = Math.min(dstCapacity, holdWeight(dst) + stepWeight);
  return transferInto(dst, src, cap);
}

/** Merge `src` entirely into `dst` (no capacity — pods merging at the cap). */
export function mergeInto(dst: Hold, src: Hold): void {
  transferInto(dst, src, Infinity);
}
