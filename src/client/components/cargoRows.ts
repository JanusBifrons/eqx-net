/**
 * C1 (plan soft-leaping-truffle v3) — turn a hold into the cargo panel's rows.
 * Pure (no React): each row is one item type with a player-facing name, how
 * many there are, and the request that moves ONE or ALL of them. Names only,
 * never ids — uids ride inside the requests and the hidden row keys.
 */
import { GOOD_DEFS, GOOD_IDS, type Hold } from '../../shared-types/goods';
import { productName } from '../../shared-types/blueprints';
import type { CargoItems } from '../../shared-types/messages/cargoMessages';

export interface CargoRow {
  /** Stable key: `g:<good>`, `p:<product>`, `b:<uid>` (testids, React keys). */
  key: string;
  label: string;
  count: number;
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
      key: `g:${id}`, label: GOOD_DEFS[id].displayName, count: n,
      one: { goods: { [id]: 1 } }, all: { goods: { [id]: n } },
    });
  }
  const packed = new Map<string, number>();
  for (const p of hold.packed ?? []) packed.set(p.product, (packed.get(p.product) ?? 0) + 1);
  for (const [product, n] of packed) {
    rows.push({
      key: `p:${product}`, label: `${productName(product)} (packed)`, count: n,
      one: { packed: [product] }, all: { packed: Array<string>(n).fill(product) },
    });
  }
  for (const b of hold.blueprints) {
    const runs = b.kind === 'bpo' ? 'original' : `${b.runs ?? 0} run${b.runs === 1 ? '' : 's'}`;
    rows.push({
      key: `b:${b.uid}`, label: `${productName(b.product)} blueprint (${runs})`, count: 1,
      one: { blueprints: [b.uid] }, all: { blueprints: [b.uid] },
    });
  }
  return rows;
}
