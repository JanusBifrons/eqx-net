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
import { GOOD_IDS, type GoodId, type Hold } from '../../shared-types/goods.js';
import { fittedUid, moduleProduct, parseProduct } from '../../shared-types/blueprints.js';
import type { BlueprintItem } from '../../shared-types/items.js';

/** The module ids fitted to a ship, from its `fitted` hold (W2 items). */
export function fittedModuleIds(h: Hold): string[] {
  const out: string[] = [];
  for (const b of h.blueprints) {
    const p = parseProduct(b.product);
    if (p.ns === 'module') out.push(p.id);
  }
  return out;
}
import type { PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { cloneHold, emptyHold, extractRequested, holdWeight, isHoldEmpty, mergeInto, transferInto, type CargoRequest } from '../../core/cargo/hold.js';
import type { HolderType, HoldRecord, HoldStore } from './HoldStore.js';
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

export interface TradeNetworkSnapshot {
  goods: Partial<Record<GoodId, number>>;
  freeCapacity: number;
  /** Pose of the network's anchor storage (the hauler docks beside it). */
  x: number;
  y: number;
}

export interface TradeTransferSpec {
  /** `intoOwner` overrides the receiving hold's owner (default: the network
   *  owner — escrow). A robot raid passes null: stolen cargo is nobody's. */
  take?: { want: Hold; intoUid: string; intoOwner?: string | null; intoType?: HolderType };
  release?: readonly string[];
  destroy?: readonly string[];
  extraOps?: readonly PersistOp[];
}

export interface TradeTransferResult {
  taken: Hold;
  overflow: Hold;
  x: number;
  y: number;
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

  /** Economy v2 W3 — the owner's operational storage in the same grid
   *  component as ANY structure `rec` (a Research Lab is not storage itself). */
  networkFor(rec: StructureRecord): StructureRecord[] {
    const out: StructureRecord[] = [];
    for (const id of this.d.componentOf(rec.id)) {
      const r = this.d.registry.get(id);
      if (r && r.owner === rec.owner && isOperationalStorage(r)) out.push(r);
    }
    return out;
  }

  /** Economy v2 W3 — persist the storage structures a caller changed directly,
   *  in ONE atomic group with `extraOps` (a lab job record, a wallet fee). */
  commitChanged(touched: readonly StructureRecord[], extraOps: readonly PersistOp[]): void {
    const puts: HoldRecord[] = [];
    for (const rec of touched) {
      const r = this.recordFor(rec);
      if (r === null) continue;
      this.persistedSig.set(rec.uid!, sig(r.hold));
      puts.push(r);
    }
    this.d.holdStore.commit(puts, [], this.persist(), extraOps);
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

  // ── P2b — processor blueprint slots ─────────────────────────────────────
  // A processor's loaded blueprint is persisted as its own hold row
  // (`bpslot:<structure uid>`, holder type 'fitted': a blueprint fitted into a
  // structure). Every move between a storage hold and a slot is ONE atomic
  // group, so a blueprint is never duplicated or lost.

  private slotUid(rec: StructureRecord): string | null {
    return rec.uid === undefined ? null : `bpslot:${rec.uid}`;
  }

  private slotRecord(rec: StructureRecord): HoldRecord | null {
    const uid = this.slotUid(rec);
    if (uid === null || rec.blueprint === undefined) return null;
    return {
      holderUid: uid, holderType: 'fitted', ownerId: rec.owner, sectorKey: this.d.sectorKey(),
      x: rec.x, y: rec.y, hold: { goods: {}, blueprints: [rec.blueprint] }, expiresAt: null,
    };
  }

  /** Room hydrate: put a persisted blueprint back in its processor's slot. */
  restoreSlot(rec: StructureRecord): void {
    const uid = this.slotUid(rec);
    if (uid === null) return;
    const bp = this.d.holdStore.get(uid)?.hold.blueprints[0];
    if (bp !== undefined) rec.blueprint = { ...bp };
  }

  /** Persist a slot after a run was spent (or a used-up copy left it). */
  persistSlot(rec: StructureRecord): void {
    const uid = this.slotUid(rec);
    if (uid === null) return;
    const r = this.slotRecord(rec);
    if (r !== null) this.d.holdStore.commit([r], [], this.persist());
    else if (this.d.holdStore.get(uid) !== undefined) this.d.holdStore.delete(uid, this.persist());
  }

  /** Same-owner operational storage in a (non-storage) structure's component. */
  private networkOf(rec: StructureRecord): StructureRecord[] {
    const out: StructureRecord[] = [];
    for (const id of this.d.componentOf(rec.id)) {
      const r = this.d.registry.get(id);
      if (r && r.owner === rec.owner && isOperationalStorage(r)) out.push(r);
    }
    return out;
  }

  /**
   * Load the best blueprint for `product` from the processor's network storage
   * into its slot (an original first, then the highest quality). A blueprint
   * already in the slot goes back to storage in the same group, unless it is
   * bound. Returns false when the network has none.
   */
  loadBlueprint(proc: StructureRecord, product: string, quality: (bp: BlueprintItem) => number): boolean {
    if (proc.blueprint?.bound === true) return false;
    const net = this.networkOf(proc);
    let best: { s: StructureRecord; i: number; bp: BlueprintItem } | null = null;
    for (const s of net) {
      const list = s.hold?.blueprints ?? [];
      for (let i = 0; i < list.length; i++) {
        const bp = list[i]!;
        if (bp.product !== product) continue;
        const better = best === null
          || (bp.kind === 'bpo' && best.bp.kind !== 'bpo')
          || (bp.kind === best.bp.kind && quality(bp) > quality(best.bp));
        if (better) best = { s, i, bp };
      }
    }
    if (best === null) return false;
    const touched = new Set<StructureRecord>([best.s]);
    best.s.hold!.blueprints.splice(best.i, 1);
    if (proc.blueprint !== undefined) {
      best.s.hold!.blueprints.push(proc.blueprint);
    }
    proc.blueprint = best.bp;
    this.commitSlotAndStorage(proc, touched);
    return true;
  }

  /** Move the slot's blueprint back into network storage (never a bound one). */
  unloadBlueprint(proc: StructureRecord): boolean {
    const bp = proc.blueprint;
    if (bp === undefined || bp.bound === true) return false;
    const target = this.networkOf(proc)[0];
    if (target === undefined) return false;
    (target.hold ??= emptyHold()).blueprints.push(bp);
    proc.blueprint = undefined;
    this.commitSlotAndStorage(proc, new Set([target]));
    return true;
  }

  /** A processor left the world: its (unbound) blueprint spills; the slot row
   *  is deleted either way. */
  takeSlotForSpill(proc: StructureRecord): Hold | null {
    const uid = this.slotUid(proc);
    const bp = proc.blueprint;
    proc.blueprint = undefined;
    if (uid !== null && this.d.holdStore.get(uid) !== undefined) this.d.holdStore.delete(uid, this.persist());
    return bp === undefined || bp.bound === true ? null : { goods: {}, blueprints: [bp] };
  }

  private commitSlotAndStorage(proc: StructureRecord, touched: Set<StructureRecord>): void {
    const puts: HoldRecord[] = [];
    const deletes: string[] = [];
    const slot = this.slotRecord(proc);
    const uid = this.slotUid(proc);
    if (slot !== null) puts.push(slot);
    else if (uid !== null && this.d.holdStore.get(uid) !== undefined) deletes.push(uid);
    for (const rec of touched) {
      const r = this.recordFor(rec);
      if (r === null) continue;
      this.persistedSig.set(rec.uid!, sig(r.hold));
      puts.push(r);
    }
    this.d.holdStore.commit(puts, deletes, this.persist());
  }

  // ── Living World P2 — trade escrow ──────────────────────────────────────

  /** The operational storage structure with this uid, owned by `owner`. */
  storageByUid(owner: string, uid: string): StructureRecord | null {
    for (const rec of this.d.registry.all()) {
      if (rec.uid === uid) return rec.owner === owner && isOperationalStorage(rec) ? rec : null;
    }
    return null;
  }

  /** What a base network can trade right now (goods incl. a Capital's mineral
   *  bank, free weight capacity). Null ⇒ no such network. Credits are in the
   *  owner's WALLET, never here. */
  tradeSnapshot(owner: string, networkUid: string): TradeNetworkSnapshot | null {
    const target = this.storageByUid(owner, networkUid);
    if (target === null) return null;
    const goods: Partial<Record<GoodId, number>> = {};
    let free = 0;
    for (const rec of this.network(target)) {
      const h = rec.hold ?? emptyHold();
      for (const g of GOOD_IDS) {
        const n = h.goods[g] ?? 0;
        if (n > 0) goods[g] = (goods[g] ?? 0) + n;
      }
      if (rec.minerals > 0) goods.minerals = (goods.minerals ?? 0) + rec.minerals;
      free += Math.max(0, holdCapacityOf(rec) - holdWeight(h));
    }
    return { goods, freeCapacity: free, x: target.x, y: target.y };
  }

  /**
   * ONE atomic trade value move against `owner`'s network at `networkUid`:
   *  - `take`: move up to `want` out of the network into holder `intoUid`
   *    (only what exists moves — the caller reads `taken`);
   *  - `release`: move each listed holder's whole hold INTO the network, then
   *    delete the holder (anything that doesn't fit is returned as `overflow`
   *    for the caller to drop as a pod at the storage);
   *  - `destroy`: holders deleted outright (value leaves the economy);
   *  - `extraOps`: the deal-state write that must land in the same group.
   * Returns null when the network no longer exists (nothing changes).
   */
  tradeTransfer(owner: string, networkUid: string, spec: TradeTransferSpec): TradeTransferResult | null {
    const target = this.storageByUid(owner, networkUid);
    if (target === null) return null;
    const net = this.network(target);
    const touched = new Set<StructureRecord>();
    const puts: HoldRecord[] = [];
    const deletes: string[] = [];
    const taken = emptyHold();
    const overflow = emptyHold();

    if (spec.take) {
      const want = spec.take.want;
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
      const existing = this.d.holdStore.get(spec.take.intoUid);
      const into = existing ? cloneHold(existing.hold) : emptyHold();
      transferInto(into, cloneHold(taken), Infinity);
      puts.push({
        holderUid: spec.take.intoUid, holderType: spec.take.intoType ?? 'hauler',
        ownerId: spec.take.intoOwner === undefined ? owner : spec.take.intoOwner,
        sectorKey: this.d.sectorKey(), x: null, y: null, hold: into, expiresAt: null,
      });
    }

    for (const uid of spec.release ?? []) {
      const rec = this.d.holdStore.get(uid);
      deletes.push(uid);
      if (rec === undefined) continue;
      const src = cloneHold(rec.hold);
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
      transferInto(overflow, src, Infinity);
    }

    for (const uid of spec.destroy ?? []) deletes.push(uid);

    for (const rec of touched) {
      const r = this.recordFor(rec);
      if (r === null) continue;
      this.persistedSig.set(rec.uid!, sig(r.hold));
      puts.push(r);
    }
    this.d.holdStore.commit(puts, deletes, this.persist(), spec.extraOps ?? []);
    return { taken, overflow, x: target.x, y: target.y };
  }

  /** Living World P3c — the nearest OPERATIONAL storage (any player owner) to
   *  (x, y) within `range`, for a robot raid. Control cadence (allocates). */
  /**
   * Living World P5 — install one `blueprintId` from `owner`'s storage network
   * at `networkUid` onto ship `shipInstanceId`: ONE atomic hold group (the
   * storage loses it, the ship's `fitted` hold gains it). Returns the ship's
   * new fitted list, or null when the network doesn't hold that blueprint.
   */
  installBlueprint(owner: string, networkUid: string, blueprintId: string, shipInstanceId: string): string[] | null {
    const target = this.storageByUid(owner, networkUid);
    if (target === null) return null;
    // W2 — blueprints are items: take a MODULE blueprint for `blueprintId`.
    const product = moduleProduct(blueprintId);
    let from: StructureRecord | null = null;
    let item: BlueprintItem | null = null;
    for (const rec of this.network(target)) {
      const i = rec.hold?.blueprints.findIndex((b) => b.product === product) ?? -1;
      if (i >= 0) {
        item = rec.hold!.blueprints.splice(i, 1)[0]!;
        from = rec;
        break;
      }
    }
    if (from === null || item === null) return null;
    const uid = fittedUid(shipInstanceId);
    const prior = this.d.holdStore.get(uid);
    const fitted = prior ? cloneHold(prior.hold) : emptyHold();
    fitted.blueprints.push(item);
    const puts: HoldRecord[] = [
      { holderUid: uid, holderType: 'fitted', ownerId: owner, sectorKey: null, x: null, y: null, hold: fitted, expiresAt: null },
    ];
    const r = this.recordFor(from);
    if (r !== null) {
      this.persistedSig.set(from.uid!, sig(r.hold));
      puts.push(r);
    }
    this.d.holdStore.commit(puts, [], this.persist());
    return fittedModuleIds(fitted);
  }

  nearestAnyStorage(x: number, y: number, range: number): StructureRecord | null {
    let best: StructureRecord | null = null;
    let bestD2 = range * range;
    for (const rec of this.d.registry.all()) {
      if (rec.uid === undefined || !isOperationalStorage(rec)) continue;
      const d2 = (rec.x - x) ** 2 + (rec.y - y) ** 2;
      if (d2 <= bestD2) { bestD2 = d2; best = rec; }
    }
    return best;
  }

  // ── C1 (plan soft-leaping-truffle v3) — open a structure's cargo ─────────
  // Access (relation, range, a live ship) is the room's call; these move the
  // items. Each move is ONE atomic group: the ship row + the structure row.

  /** What the cargo pane shows: the goods hold plus a Capital's bank. */
  cargoView(rec: StructureRecord): { hold: Hold; used: number; capacity: number } {
    return { hold: this.payloadOf(rec), used: holdWeight(rec.hold ?? emptyHold()), capacity: holdCapacityOf(rec) };
  }

  /**
   * Structure → ship: move the requested items into the ship's hold, up to
   * `shipCapacity`. Minerals come out of the goods hold first, then a
   * Capital's bank. Returns what moved (empty ⇒ nothing changed).
   */
  cargoTake(shipInstanceId: string, shipOwner: string, rec: StructureRecord, want: CargoRequest, shipCapacity: number): Hold {
    const ship = cloneHold(this.d.holdStore.get(shipInstanceId)?.hold ?? emptyHold());
    // The source is the payload view (goods + bank minerals) so the bank can be drawn on.
    const src = this.payloadOf(rec);
    const picked = extractRequested(src, want);
    const { moved } = transferInto(ship, picked, shipCapacity);
    mergeInto(src, picked); // whatever didn't fit stays in the structure
    if (isHoldEmpty(moved)) return moved;
    // Split the remaining minerals back: the bank keeps up to what it had, the
    // rest stays in the goods hold (so a take draws on the goods hold first).
    const bankCap = getStructureKind(rec.kind).storageCapacity;
    if (bankCap > 0) {
      const m = src.goods.minerals ?? 0;
      rec.minerals = Math.min(rec.minerals, m);
      const rest = m - rec.minerals;
      if (rest > 0) src.goods.minerals = rest;
      else delete src.goods.minerals;
    }
    rec.hold = src;
    this.commitShipAndStructures(shipInstanceId, shipOwner, ship, [rec]);
    return moved;
  }

  /**
   * Ship → structure: move the requested items into THIS structure (not its
   * network: the pilot chose it). Minerals fill a Capital's bank first, like
   * a deposit. Whatever doesn't fit stays aboard. Returns what moved.
   */
  cargoPut(shipInstanceId: string, shipOwner: string, rec: StructureRecord, want: CargoRequest): Hold {
    const shipRow = this.d.holdStore.get(shipInstanceId);
    if (shipRow === undefined) return emptyHold();
    const ship = cloneHold(shipRow.hold);
    const picked = extractRequested(ship, want);
    const moved = emptyHold();
    const bankCap = getStructureKind(rec.kind).storageCapacity;
    const carried = picked.goods.minerals ?? 0;
    if (bankCap > 0 && carried > 0) {
      const fit = Math.max(0, Math.min(carried, bankCap - rec.minerals));
      if (fit > 0) {
        rec.minerals += fit;
        moved.goods.minerals = fit;
        if (carried - fit > 0) picked.goods.minerals = carried - fit;
        else delete picked.goods.minerals;
      }
    }
    const hold = rec.hold ?? emptyHold();
    const r = transferInto(hold, picked, holdCapacityOf(rec));
    rec.hold = hold;
    mergeInto(moved, r.moved);
    mergeInto(ship, picked); // leftover stays aboard
    if (isHoldEmpty(moved)) return moved;
    this.commitShipAndStructures(shipInstanceId, shipOwner, ship, [rec]);
    return moved;
  }

  // ── T4: buy from / sell to an NPC Freight Dock ──────────────────────────
  // The room clamps `n` (stock, cargo space, wallet, volume) and builds the
  // wallet op; each trade is ONE atomic group: ship row + touched storage +
  // the wallet op.

  /** Units of `good` the dock's whole storage network holds (incl. banks). */
  networkStock(dock: StructureRecord, good: GoodId): number {
    let n = 0;
    for (const r of this.network(dock)) {
      n += r.hold?.goods[good] ?? 0;
      if (good === 'minerals') n += r.minerals;
    }
    return n;
  }

  /** Free goods-hold weight in the dock itself (sold goods land there). */
  dockFreeWeight(dock: StructureRecord): number {
    return Math.max(0, holdCapacityOf(dock) - holdWeight(dock.hold ?? emptyHold()));
  }

  /** Buy: move `n` of `good` from the dock's network into the ship. Returns
   *  the units moved (the room pre-clamped `n`, so all of them). */
  marketBuy(shipInstanceId: string, shipOwner: string, dock: StructureRecord, good: GoodId, n: number, extraOps: readonly PersistOp[]): number {
    const ship = cloneHold(this.d.holdStore.get(shipInstanceId)?.hold ?? emptyHold());
    let need = n;
    const touched: StructureRecord[] = [];
    for (const r of this.network(dock)) {
      if (need <= 0) break;
      const have = r.hold?.goods[good] ?? 0;
      let took = 0;
      if (have > 0) {
        const t = Math.min(have, need);
        if (have - t > 0) r.hold!.goods[good] = have - t;
        else delete r.hold!.goods[good];
        took += t;
        need -= t;
      }
      if (good === 'minerals' && need > 0 && r.minerals > 0) {
        const t = Math.min(r.minerals, need);
        r.minerals -= t;
        took += t;
        need -= t;
      }
      if (took > 0) touched.push(r);
    }
    const moved = n - need;
    if (moved <= 0) return 0;
    ship.goods[good] = (ship.goods[good] ?? 0) + moved;
    this.commitShipAndStructures(shipInstanceId, shipOwner, ship, touched, extraOps);
    return moved;
  }

  /** Sell: move `n` of `good` from the ship into the dock. Returns the units
   *  moved (pre-clamped by the room to what the ship holds and the dock fits). */
  marketSell(shipInstanceId: string, shipOwner: string, dock: StructureRecord, good: GoodId, n: number, extraOps: readonly PersistOp[]): number {
    const row = this.d.holdStore.get(shipInstanceId);
    if (row === undefined || n <= 0) return 0;
    const ship = cloneHold(row.hold);
    const have = ship.goods[good] ?? 0;
    const moved = Math.min(have, n);
    if (moved <= 0) return 0;
    if (have - moved > 0) ship.goods[good] = have - moved;
    else delete ship.goods[good];
    const hold = dock.hold ?? emptyHold();
    hold.goods[good] = (hold.goods[good] ?? 0) + moved;
    dock.hold = hold;
    this.commitShipAndStructures(shipInstanceId, shipOwner, ship, [dock], extraOps);
    return moved;
  }

  /** Weight currently held across a target's network (inspector / tests). */
  networkWeight(target: StructureRecord): number {
    let w = 0;
    for (const r of this.network(target)) w += holdWeight(r.hold ?? emptyHold());
    return w;
  }

  private commitShipAndStructures(shipInstanceId: string, ownerId: string, ship: Hold, touched: StructureRecord[], extraOps: readonly PersistOp[] = []): void {
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
    this.d.holdStore.commit(puts, deletes, this.persist(), extraOps);
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
