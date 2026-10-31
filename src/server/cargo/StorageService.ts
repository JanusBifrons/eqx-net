/**
 * StorageService — base storage holds for ONE sector (plan peppy-jumping-pinwheel
 * P1a-2). Decision logic over injected hooks (unit-testable without a room).
 *
 * Storage is physical: a structure with `holdCapacity > 0` (Capital, Cargo Bay)
 * keeps deposited goods in `rec.hold`. Minerals delivered to a CAPITAL go to its
 * construction bank (`rec.minerals`, capped by `storageCapacity`) so loot can
 * fund building. Connected same-owner storage forms ONE network: a deposit
 * fills the nearest storage first, then overflows across the grid component.
 *
 * Persistence (hostile-review A4): every structure hold (with its minerals) is a
 * row in the `holds` table keyed by the structure's STABLE `uid`.
 *  - A PLAYER transfer (deposit / refine) commits the ship side AND every touched
 *    structure as ONE atomic group — no duplication window.
 *  - Server-internal mineral flows (mining, hauling, construction) are flushed by
 *    `flushDirty()` on the ~1 Hz grid pulse — a crash loses at most ~1 s of
 *    mining, it can never duplicate player value.
 */
import type { Hold } from '../../shared-types/goods.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { cloneHold, emptyHold, holdWeight, isHoldEmpty, transferInto } from '../../core/cargo/hold.js';
import type { HoldRecord, HoldStore } from './HoldStore.js';
import type { StructureRecord, StructureRegistry } from '../structures/StructureRegistry.js';

/** Fly within this distance of your own storage to deposit. */
export const DEPOSIT_RANGE = 400;
/** Hold position this long (60 Hz ticks) to deposit — 2 s. */
export const DEPOSIT_DWELL_TICKS = 120;
/** Refine: 1 salvage → this many minerals (weight-neutral: 1 vs 10 × 0.1). */
export const SALVAGE_TO_MINERALS = 10;
/** Credit sinks — re-exported from shared-types/goods (#15: the UI labels read the
 *  same numbers). */
export { REPAIR_CREDITS_PER_HP, RESPEC_CREDIT_COST } from '../../shared-types/goods.js';

export interface StorageServiceDeps {
  holdStore: HoldStore;
  registry: StructureRegistry;
  sectorKey: () => string | null;
  /** Ids of every structure in the same grid component as `id` (incl. `id`). */
  componentOf: (id: string) => readonly string[];
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

export class StorageService {
  /** uid → signature of the last persisted payload (dirty detection). */
  private readonly persistedSig = new Map<string, string>();

  constructor(private readonly d: StorageServiceDeps) {}

  private persist(): boolean {
    return this.d.sectorKey() !== null;
  }

  /** The full persisted payload of a structure: its goods hold PLUS (for a
   *  Capital) the construction bank as `minerals`. */
  payloadOf(rec: StructureRecord): Hold {
    const h = cloneHold(rec.hold ?? emptyHold());
    if (getStructureKind(rec.kind).storageCapacity > 0 && rec.minerals > 0) {
      h.goods.minerals = (h.goods.minerals ?? 0) + rec.minerals;
    }
    return h;
  }

  private recordFor(rec: StructureRecord): HoldRecord | null {
    if (rec.uid === undefined) return null;
    return {
      holderUid: rec.uid, holderType: 'structure', ownerId: rec.owner,
      sectorKey: this.d.sectorKey(), x: rec.x, y: rec.y,
      hold: this.payloadOf(rec), expiresAt: null,
    };
  }

  /** Room hydrate: overlay the (fresher) holds-table payload onto a restored
   *  structure. Minerals go back to a Capital's bank (capped); everything else
   *  into its goods hold. */
  restore(rec: StructureRecord): void {
    if (rec.uid === undefined) return;
    const row = this.d.holdStore.get(rec.uid);
    if (row === undefined) return;
    const h = cloneHold(row.hold);
    const bankCap = getStructureKind(rec.kind).storageCapacity;
    if (bankCap > 0) {
      const m = h.goods.minerals ?? 0;
      rec.minerals = Math.min(bankCap, m);
      const rest = m - rec.minerals;
      if (rest > 0) h.goods.minerals = rest;
      else delete h.goods.minerals;
    }
    rec.hold = h;
    this.persistedSig.set(rec.uid, sig(this.payloadOf(rec)));
  }

  /** ~1 Hz: persist every storage structure whose payload changed (mining /
   *  hauling / construction flows mutate `rec.minerals` directly). */
  flushDirty(): void {
    const puts: HoldRecord[] = [];
    for (const rec of this.d.registry.all()) {
      if (rec.uid === undefined) continue;
      if (!isStorage(rec) && getStructureKind(rec.kind).storageCapacity <= 0) continue;
      const r = this.recordFor(rec)!;
      const s = sig(r.hold);
      if (this.persistedSig.get(rec.uid) === s) continue;
      this.persistedSig.set(rec.uid, s);
      puts.push(r);
    }
    if (puts.length > 0) this.d.holdStore.commit(puts, [], this.persist());
  }

  /** Nearest OPERATIONAL storage owned by `owner` within `range` of (x, y). */
  nearestOwnStorage(owner: string, x: number, y: number, range = DEPOSIT_RANGE): StructureRecord | null {
    let best: StructureRecord | null = null;
    let bestD2 = range * range;
    for (const rec of this.d.registry.all()) {
      if (rec.owner !== owner || !isOperationalStorage(rec)) continue;
      const d2 = (rec.x - x) ** 2 + (rec.y - y) ** 2;
      if (d2 <= bestD2) { bestD2 = d2; best = rec; }
    }
    return best;
  }

  /** The storage network reachable from `target`: target first, then the other
   *  operational same-owner storage in its grid component. */
  network(target: StructureRecord): StructureRecord[] {
    const out: StructureRecord[] = [target];
    for (const id of this.d.componentOf(target.id)) {
      if (id === target.id) continue;
      const r = this.d.registry.get(id);
      if (r && r.owner === target.owner && isOperationalStorage(r)) out.push(r);
    }
    return out;
  }

  /**
   * Deposit a ship's whole carried hold into `target`'s storage network.
   * Minerals go to a Capital bank first (they fund construction); everything
   * else fills holds by capacity. Whatever doesn't fit STAYS on the ship.
   * Ship side + every touched structure commit as ONE atomic group.
   * Returns what was moved (empty hold ⇒ nothing deposited).
   */
  deposit(shipInstanceId: string, ownerId: string, target: StructureRecord): Hold {
    const moved = emptyHold();
    const shipRow = this.d.holdStore.get(shipInstanceId);
    if (shipRow === undefined || isHoldEmpty(shipRow.hold)) return moved;
    const ship = cloneHold(shipRow.hold);
    const touched: StructureRecord[] = [];
    for (const rec of this.network(target)) {
      let touchedThis = false;
      // 1) Minerals → a Capital's construction bank.
      const bankCap = getStructureKind(rec.kind).storageCapacity;
      const carried = ship.goods.minerals ?? 0;
      if (bankCap > 0 && carried > 0) {
        const fit = Math.max(0, Math.min(carried, bankCap - rec.minerals));
        if (fit > 0) {
          rec.minerals += fit;
          moved.goods.minerals = (moved.goods.minerals ?? 0) + fit;
          if (carried - fit > 0) ship.goods.minerals = carried - fit;
          else delete ship.goods.minerals;
          touchedThis = true;
        }
      }
      // 2) Everything else → the goods hold, by weight.
      if (isHoldEmpty(ship)) { if (touchedThis) touched.push(rec); break; }
      const hold = rec.hold ?? emptyHold();
      const r = transferInto(hold, ship, holdCapacityOf(rec));
      if (!isHoldEmpty(r.moved)) {
        rec.hold = hold;
        transferInto(moved, r.moved, Infinity);
        touchedThis = true;
      }
      if (touchedThis) touched.push(rec);
      if (isHoldEmpty(ship)) break;
    }
    if (isHoldEmpty(moved)) return moved;
    this.commitShipAndStructures(shipInstanceId, ownerId, ship, touched);
    return moved;
  }

  /** Refine salvage from the network into a Capital's mineral bank. */
  refine(capital: StructureRecord, qty: number): number {
    if (getStructureKind(capital.kind).storageCapacity <= 0 || !isOperationalStorage(capital)) return 0;
    const room = Math.floor((getStructureKind(capital.kind).storageCapacity - capital.minerals) / SALVAGE_TO_MINERALS);
    let want = Math.min(Math.max(0, Math.floor(qty)), room);
    if (want <= 0) return 0;
    const touched: StructureRecord[] = [];
    let refined = 0;
    for (const rec of this.network(capital)) {
      const have = rec.hold?.goods.salvage ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, want);
      const left = have - take;
      if (left > 0) rec.hold!.goods.salvage = left;
      else delete rec.hold!.goods.salvage;
      refined += take;
      want -= take;
      touched.push(rec);
      if (want <= 0) break;
    }
    if (refined === 0) return 0;
    capital.minerals += refined * SALVAGE_TO_MINERALS;
    if (!touched.includes(capital)) touched.push(capital);
    this.commitStructures(touched);
    return refined;
  }

  /** Credits banked across ALL of `owner`'s storage in this sector. */
  creditsOf(owner: string): number {
    let c = 0;
    for (const rec of this.d.registry.all()) {
      if (rec.owner === owner && isOperationalStorage(rec)) c += rec.hold?.credits ?? 0;
    }
    return c;
  }

  /**
   * Spend `amount` credits from `owner`'s banked storage in this sector
   * (a credit SINK: repairs, respecs). All-or-nothing — returns false and
   * changes nothing when the balance is short. One atomic group.
   */
  spendCredits(owner: string, amount: number): boolean {
    if (amount <= 0) return true;
    if (this.creditsOf(owner) < amount) return false;
    let left = amount;
    const touched: StructureRecord[] = [];
    for (const rec of this.d.registry.all()) {
      if (left <= 0) break;
      if (rec.owner !== owner || !isOperationalStorage(rec)) continue;
      const have = rec.hold?.credits ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, left);
      rec.hold!.credits = have - take;
      left -= take;
      touched.push(rec);
    }
    this.commitStructures(touched);
    return true;
  }

  /** A storage structure left the world (razed / deconstructed): return its
   *  whole payload (for the caller to spill) and delete its holds row. */
  takeForSpill(rec: StructureRecord): Hold | null {
    if (rec.uid === undefined) return null;
    const payload = this.payloadOf(rec);
    rec.hold = emptyHold();
    this.persistedSig.delete(rec.uid);
    if (this.d.holdStore.get(rec.uid) !== undefined) this.d.holdStore.delete(rec.uid, this.persist());
    return isHoldEmpty(payload) ? null : payload;
  }

  /** Weight currently held across a target's network (inspector / tests). */
  networkWeight(target: StructureRecord): number {
    let w = 0;
    for (const r of this.network(target)) w += holdWeight(r.hold ?? emptyHold());
    return w;
  }

  private commitShipAndStructures(shipInstanceId: string, ownerId: string, ship: Hold, touched: StructureRecord[]): void {
    const puts: HoldRecord[] = [];
    const deletes: string[] = [];
    if (isHoldEmpty(ship)) deletes.push(shipInstanceId);
    else puts.push({ holderUid: shipInstanceId, holderType: 'ship', ownerId, sectorKey: null, x: null, y: null, hold: ship, expiresAt: null });
    for (const rec of touched) {
      const r = this.recordFor(rec);
      if (r === null) continue;
      this.persistedSig.set(rec.uid!, sig(r.hold));
      puts.push(r);
    }
    this.d.holdStore.commit(puts, deletes, this.persist());
  }

  private commitStructures(touched: StructureRecord[]): void {
    const puts: HoldRecord[] = [];
    for (const rec of touched) {
      const r = this.recordFor(rec);
      if (r === null) continue;
      this.persistedSig.set(rec.uid!, sig(r.hold));
      puts.push(r);
    }
    if (puts.length > 0) this.d.holdStore.commit(puts, [], this.persist());
  }
}

/** Stable payload signature (sorted keys) for dirty detection. 1 Hz, off-tick. */
function sig(h: Hold): string {
  const keys = Object.keys(h.goods).sort();
  let s = `${h.credits}|${h.blueprints.length}`;
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
