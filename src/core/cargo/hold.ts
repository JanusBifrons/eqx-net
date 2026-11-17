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

/** Cargo weight of one packed ITEM: its own `weight` (a rock chunk) or its
 *  product's (`packedWeightOf`). Every weight sum reads this. */
export function packedItemWeight(p: PackedItem): number {
  return p.weight ?? packedWeightOf(p.product);
}

/** Add one packed item (the production pass / a test seed). Mutates. */
export function addPacked(h: Hold, product: string, quality: number): void {
  (h.packed ??= []).push({ product, quality: Math.max(0, Math.min(100, Math.round(quality))) });
}

/** Take a packed item out of `h`: the one whose `uid` is `key` (a rock
 *  chunk), else the best-quality one of product `key` (placement / unpack);
 *  null when there is none. Mutates. */
export function takePacked(h: Hold, key: string): PackedItem | null {
  const list = h.packed;
  if (!list) return null;
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.uid === key) { best = i; break; }
  }
  if (best < 0) {
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.uid === undefined && list[i]!.product === key && (best < 0 || list[i]!.quality > list[best]!.quality)) best = i;
    }
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
  if (h.packed && h.packed.length > 0) c.packed = h.packed.map((p) => (p.ore !== undefined ? { ...p, ore: { ...p.ore } } : { ...p }));
  return c;
}

/** Last `wireHold` result per hold: the packed list it was built from and
 *  its length, so a snapshot resends the same copy (no per-tick alloc, #14). */
const wireCache = new WeakMap<Hold, { packed: PackedItem[]; n: number; out: Hold }>();

/** `h` as a client may see it: a rock chunk's hidden `ore` stripped (the
 *  gacha: you learn a chunk's ore only at the refinery). Returns `h` itself
 *  when nothing is hidden; a stripped copy shares `goods`/`blueprints` and is
 *  cached per hold while its packed list is unchanged. */
export function wireHold(h: Hold): Hold {
  const list = h.packed;
  if (list === undefined) return h;
  let hidden = false;
  for (const p of list) if (p.ore !== undefined) { hidden = true; break; }
  if (!hidden) return h;
  const hit = wireCache.get(h);
  if (hit !== undefined && hit.packed === list && hit.n === list.length && hit.out.goods === h.goods && hit.out.blueprints === h.blueprints) return hit.out;
  const out: Hold = { goods: h.goods, blueprints: h.blueprints, packed: list.map((p) => {
    if (p.ore === undefined) return p;
    const { ore: _ore, ...shown } = p;
    return shown;
  }) };
  wireCache.set(h, { packed: list, n: list.length, out });
  return out;
}

/** Total cargo weight (blueprints weigh nothing; credits are not cargo;
 *  packed structures / hulls are heavy). */
export function holdWeight(h: Hold): number {
  let w = 0;
  for (const id of GOOD_IDS) {
    const n = h.goods[id];
    if (n) w += n * GOOD_DEFS[id].weight;
  }
  if (h.packed) for (const p of h.packed) w += packedItemWeight(p);
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
      const w = packedItemWeight(p);
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

/** Merge `src` entirely into `dst` (no capacity — pods merging at the cap). */
export function mergeInto(dst: Hold, src: Hold): void {
  transferInto(dst, src, Infinity);
}

/** C1 (plan soft-leaping-truffle v3) — the items a player asked to move
 *  between two holds: goods by count, blueprints by uid, packed items by
 *  product, or by uid for a one-of-a-kind item (a rock chunk; one entry per
 *  item). */
export interface CargoRequest {
  goods?: Partial<Record<GoodId, number>>;
  blueprints?: readonly string[];
  packed?: readonly string[];
}

/**
 * Remove exactly the requested items from `src` (each clamped to what `src`
 * holds; unknown uids/products are ignored) and return them as a new hold.
 * Mutates `src`. Value is conserved: `src` loses exactly what is returned.
 * Pair it with `transferInto(dst, picked, cap)` and merge the leftover back
 * into `src`, so a capacity-limited move never drops anything.
 */
export function extractRequested(src: Hold, want: CargoRequest): Hold {
  const out = emptyHold();
  if (want.goods) {
    for (const id of GOOD_IDS) {
      const asked = want.goods[id];
      if (asked === undefined || !(asked > 0)) continue;
      const have = src.goods[id] ?? 0;
      const n = Math.min(have, Math.floor(asked));
      if (n <= 0) continue;
      out.goods[id] = n;
      if (have - n > 0) src.goods[id] = have - n;
      else delete src.goods[id];
    }
  }
  if (want.blueprints && want.blueprints.length > 0) {
    for (const uid of want.blueprints) {
      const i = src.blueprints.findIndex((b) => b.uid === uid);
      if (i >= 0) out.blueprints.push(src.blueprints.splice(i, 1)[0]!);
    }
  }
  if (want.packed && want.packed.length > 0) {
    for (const key of want.packed) {
      const item = takePacked(src, key);
      if (item) (out.packed ??= []).push(item);
    }
  }
  return out;
}

/** Anything with a fair coin (`Rng.chance`), so the roll stays seedable. */
export interface CoinFlipper {
  chance(num: number, den: number): boolean;
}

/**
 * Death loss, EVE style (owner 2026-11-17): every STACK of a dead ship's hold
 * is a fair coin flip, kept whole or destroyed whole. A stack is one good id,
 * one blueprint, or one packed item. Flips run in a fixed order (goods in
 * `GOOD_IDS` order, then blueprints, then packed) so a seeded `rng` gives the
 * same survivors every time. Returns the survivors as a new hold; `hold` is
 * not touched.
 */
export function rollDeathLoss(hold: Hold, rng: CoinFlipper): Hold {
  const out = emptyHold();
  for (const id of GOOD_IDS) {
    const n = hold.goods[id] ?? 0;
    if (n > 0 && rng.chance(1, 2)) out.goods[id] = n;
  }
  for (const b of hold.blueprints) if (rng.chance(1, 2)) out.blueprints.push({ ...b });
  if (hold.packed !== undefined) {
    for (const p of hold.packed) {
      if (!rng.chance(1, 2)) continue;
      (out.packed ??= []).push({ ...p });
    }
  }
  return out;
}
