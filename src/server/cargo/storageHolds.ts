/**
 * Pure storage hold helpers (moved out of StorageService.ts): which
 * structures are storage, what a filtered deposit would move, network take /
 * release, payload signatures and the stable structure uid.
 */
import { GOOD_DEFS, GOOD_IDS, type GoodId, type Hold } from '../../shared-types/goods.js';
import { parseProduct } from '../../shared-types/blueprints.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { emptyHold, holdWeight, isHoldEmpty, transferInto } from '../../core/cargo/hold.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';

/** The module ids fitted to a ship, from its `fitted` hold (W2 items). */
export function fittedModuleIds(h: Hold): string[] {
  const out: string[] = [];
  for (const b of h.blueprints) {
    const p = parseProduct(b.product);
    if (p.ns === 'module') out.push(p.id);
  }
  return out;
}

/** Every unit of each `intake` good aboard `h`, as a `CargoRequest.goods`. */
export function intakeRequest(h: Hold, intake: ReadonlySet<GoodId>): Partial<Record<GoodId, number>> {
  const out: Partial<Record<GoodId, number>> = {};
  for (const g of intake) {
    const n = h.goods[g] ?? 0;
    if (n > 0) out[g] = n;
  }
  return out;
}

/** Weight a `deposit(…, intake)` would take off `h` (storage room aside):
 *  the whole hold with no filter, else just the intake goods (alloc-free). */
export function holdIntakeWeight(h: Hold, intake: ReadonlySet<GoodId> | undefined): number {
  if (intake === undefined) return holdWeight(h);
  let w = 0;
  for (const g of intake) w += (h.goods[g] ?? 0) * GOOD_DEFS[g].weight;
  return w;
}

/** A structure's own units of `good` (goods hold, plus a bank's minerals). */
export function stockOf(r: StructureRecord, good: GoodId): number {
  return (r.hold?.goods[good] ?? 0) + (good === 'minerals' ? r.minerals : 0);
}

/** True when a `deposit(…, intake)` could move something from `h`: any cargo
 *  with no filter, else any good the intake names (alloc-free). */
export function holdHasIntake(h: Hold, intake: ReadonlySet<GoodId> | undefined): boolean {
  if (intake === undefined) return !isHoldEmpty(h);
  for (const g of intake) if ((h.goods[g] ?? 0) > 0) return true;
  return false;
}

export function holdCapacityOf(rec: StructureRecord): number {
  return getStructureKind(rec.kind).holdCapacity ?? 0;
}

export function isStorage(rec: StructureRecord): boolean {
  return holdCapacityOf(rec) > 0;
}

/** Built, or mid-UPGRADE (a re-build of an operational structure) — the same
 *  carve-out the construction funder uses. A fresh blueprint can't store. */
export function isOperationalStorage(rec: StructureRecord): boolean {
  return isStorage(rec) && (rec.isConstructed || rec.upgradeTargetLevel !== undefined);
}

/** `tradeTransfer` take: move up to `want` (less what `taken` already has)
 *  out of network `net` into `taken`, goods holds first, then a bank's
 *  minerals. Every structure drawn on is added to `touched`. */
export function takeFromNetwork(net: readonly StructureRecord[], want: Hold, taken: Hold, touched: Set<StructureRecord>): void {
  for (const rec of net) {
    const h = rec.hold;
    for (const g of GOOD_IDS) {
      let need = (want.goods[g] ?? 0) - (taken.goods[g] ?? 0);
      if (need <= 0) continue;
      const have = h?.goods[g] ?? 0;
      if (have > 0) {
        const t = Math.min(have, need);
        if (have - t > 0) h!.goods[g] = have - t;
        else delete h!.goods[g];
        taken.goods[g] = (taken.goods[g] ?? 0) + t;
        need -= t;
        touched.add(rec);
      }
      if (g === 'minerals' && need > 0 && rec.minerals > 0) {
        const t = Math.min(rec.minerals, need);
        rec.minerals -= t;
        taken.goods.minerals = (taken.goods.minerals ?? 0) + t;
        touched.add(rec);
      }
    }
  }
}

/** `tradeTransfer` release: move `src` into network `net` (minerals fill a
 *  Capital's bank first, then holds by capacity). Whatever doesn't fit stays
 *  in `src`. Every structure filled is added to `touched`. */
export function releaseIntoNetwork(net: readonly StructureRecord[], src: Hold, touched: Set<StructureRecord>): void {
  for (const s of net) {
    const bankCap = getStructureKind(s.kind).storageCapacity;
    const m = src.goods.minerals ?? 0;
    if (bankCap > 0 && m > 0) {
      const fit = Math.max(0, Math.min(m, bankCap - s.minerals));
      if (fit > 0) {
        s.minerals += fit;
        if (m - fit > 0) src.goods.minerals = m - fit;
        else delete src.goods.minerals;
        touched.add(s);
      }
    }
    if (isHoldEmpty(src)) break;
    const hold = s.hold ?? emptyHold();
    const r = transferInto(hold, src, holdCapacityOf(s));
    if (!isHoldEmpty(r.moved)) { s.hold = hold; touched.add(s); }
    if (isHoldEmpty(src)) break;
  }
}

/** Stable payload signature (sorted keys) for dirty detection. 1 Hz, off-tick. */
export function sig(h: Hold): string {
  const keys = Object.keys(h.goods).sort();
  let s = `${h.blueprints.length}|${h.packed?.length ?? 0}`;
  for (const b of h.blueprints) s += `|${b.uid}:${b.runs ?? 'o'}:${b.material}:${b.output}`;
  for (const k of keys) s += `|${k}:${(h.goods as Record<string, number>)[k]}`;
  return s;
}

/** Deterministic, stable structure uid: FNV-1a over (sector, owner, kind,
 *  rounded pose). All four inputs are persisted, so a restore recomputes it. */
export function structureUid(sectorKey: string | null, owner: string, kind: string, x: number, y: number): string {
  const s = `${sectorKey ?? 'eng'}|${owner}|${kind}|${Math.round(x)}|${Math.round(y)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let h2 = 0x9e3779b1;
  for (let i = s.length - 1; i >= 0; i--) {
    h2 ^= s.charCodeAt(i);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `st-${h.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
