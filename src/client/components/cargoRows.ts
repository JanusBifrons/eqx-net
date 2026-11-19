/**
 * C1 (plan soft-leaping-truffle v3) — turn a hold into the cargo panel's rows.
 * Pure (no React): each row is one item type with a player-facing name, how
 * many there are, and the request that moves ONE or ALL of them. Names only,
 * never ids — uids ride inside the requests and the hidden row keys.
 */
import { GOOD_DEFS, GOOD_IDS, type Hold } from '../../shared-types/goods';
import { productName } from '../../shared-types/blueprints';
import type { CargoItems } from '../../shared-types/messages/cargoMessages';
import { ROCK_CHUNK_PRODUCT } from '../../shared-types/items';

export interface CargoRow {
  /** Stable key: `g:<good>`, `p:<product>`, `u:<uid>` (a rock chunk: one
   *  tile each), `b:<uid>` (testids, React keys). */
  key: string;
  label: string;
  count: number;
  /** Rarity 0..2 (grey / blue / gold, like the pod beacon); blueprints and
   *  packed items are top tier. */
  tier: 0 | 1 | 2;
  one: CargoItems;
  all: CargoItems;
}

/** Rows in a fixed order: goods (catalogue order), packed items, blueprints. */
export function cargoRows(hold: Hold | null): CargoRow[] {
  const rows: CargoRow[] = [];
  if (hold === null) return rows;
  for (const id of GOOD_IDS) {
    const n = hold.goods[id] ?? 0;
    if (n <= 0) continue;
    rows.push({
      key: `g:${id}`, label: GOOD_DEFS[id].displayName, count: n, tier: GOOD_DEFS[id].tier,
      one: { goods: { [id]: 1 } }, all: { goods: { [id]: n } },
    });
  }
  const packed = new Map<string, number>();
  for (const p of hold.packed ?? []) if (p.uid === undefined) packed.set(p.product, (packed.get(p.product) ?? 0) + 1);
  for (const [product, n] of packed) {
    rows.push({
      key: `p:${product}`, label: `${productName(product)} (packed)`, count: n, tier: 2,
      one: { packed: [product] }, all: { packed: Array<string>(n).fill(product) },
    });
  }
  // A one-of-a-kind item (a rock chunk) is its own tile, moved by its uid;
  // what is in it stays hidden until a refinery breaks it down.
  for (const p of hold.packed ?? []) {
    if (p.uid === undefined) continue;
    rows.push({
      key: `u:${p.uid}`, label: p.product === ROCK_CHUNK_PRODUCT ? 'Rock chunk' : productName(p.product), count: 1, tier: 1,
      one: { packed: [p.uid] }, all: { packed: [p.uid] },
    });
  }
  for (const b of hold.blueprints) {
    const runs = b.kind === 'bpo' ? 'original' : `${b.runs ?? 0} run${b.runs === 1 ? '' : 's'}`;
    rows.push({
      key: `b:${b.uid}`, label: `${productName(b.product)} blueprint (${runs})`, count: 1, tier: 2,
      one: { blueprints: [b.uid] }, all: { blueprints: [b.uid] },
    });
  }
  return rows;
}

/** Every row's whole stack in one request ("Take all found"). */
export function allOf(rows: readonly CargoRow[]): CargoItems {
  const goods: Record<string, number> = {};
  const packed: string[] = [];
  const blueprints: string[] = [];
  for (const r of rows) {
    for (const [g, n] of Object.entries(r.all.goods ?? {})) goods[g] = (goods[g] ?? 0) + (n ?? 0);
    if (r.all.packed) packed.push(...r.all.packed);
    if (r.all.blueprints) blueprints.push(...r.all.blueprints);
  }
  const out: CargoItems = { goods: goods as CargoItems['goods'] };
  if (packed.length > 0) out.packed = packed;
  if (blueprints.length > 0) out.blueprints = blueprints;
  return out;
}

/** Slice 19: just one row's stack of a hold (for its weight). */
export function rowHold(hold: Hold, row: CargoRow): Hold {
  const goods = row.all.goods ?? {};
  const key = row.all.packed?.[0];
  const packed = key !== undefined ? (hold.packed ?? []).filter((p) => p.uid === key || (p.uid === undefined && p.product === key)) : [];
  const uids = row.all.blueprints ?? [];
  return {
    goods: { ...goods },
    blueprints: hold.blueprints.filter((b) => uids.includes(b.uid)),
    ...(packed.length > 0 ? { packed } : {}),
  };
}
