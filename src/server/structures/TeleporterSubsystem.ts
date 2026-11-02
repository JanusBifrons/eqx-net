/**
 * Teleporters (plan soft-leaping-truffle v4, T1): capacitors, pairing, firing
 * rules, the jump cycle and the pad swap. One instance per SectorRoom.
 *
 *  - CHARGE: spare grid power left after the batteries fill tops up each
 *    paired teleporter's capacitor to the charge its jump needs
 *    (`jumpCharge(distance)`; distance is all that matters).
 *  - FIRE: a pad fires when its owner presses Fire or one of its rules is met
 *    (when charged / when loaded / when a ship boards), if it is charged and
 *    both pads are idle.
 *  - CYCLE: both pads arm, close, seal, swap and open together; the end that
 *    fired spends its charge at the swap. The pad holds trade places in one
 *    atomic group (ships join in T2).
 *  - PULSE (1 Hz): goods that just arrived unload into base storage, then a
 *    "keep loaded" rule tops the pad back up.
 *
 * T1 pairs teleporters in the same sector only; T3 adds other sectors.
 */
import { isTeleporterKind, jumpCharge, jumpDistance, PAD_SPECS, TP_PHASE, type TeleportRules } from '../../shared-types/teleport.js';
import { DEFAULT_TELEPORT_RULES } from '../../shared-types/teleport.js';
import { holdWeight } from '../../core/cargo/hold.js';
import { armCycle, rulesSayFire, stepCycle, type CycleState } from '../../core/structures/teleportCycle.js';
import type { StorageService } from '../cargo/StorageService.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

export interface TeleporterHooks {
  registry: StructureRegistry;
  storage: StorageService;
  sectorKey(): string | null;
  /** Built and on a powered grid. */
  isPowered(rec: StructureRecord): boolean;
  /** Phase speed-up for tests (1 = real time). */
  cycleScale(): number;
  /** How many ships sit on this pad now (for "when a ship boards"). */
  shipsOnPad(rec: StructureRecord): number;
  /** A teleporter's state changed (room state must be re-synced). */
  onChanged(): void;
  /** T2 — move the ships on the two pads at the swap. */
  onSwapShips?(a: StructureRecord, b: StructureRecord): void;
  /** T2 — the iris spans (solid only while SEALED) and the closing push. */
  spawnIris?(rec: StructureRecord): void;
  setIrisActive?(rec: StructureRecord, active: boolean): void;
  removeIris?(rec: StructureRecord): void;
  setPadField?(rec: StructureRecord, active: boolean): void;
}

const EMPTY_GOODS: Readonly<Record<string, number>> = Object.freeze({});

export class TeleporterSubsystem {
  private readonly cycle: CycleState = { phase: TP_PHASE.IDLE, phaseEndsAtMs: 0 };

  constructor(private readonly h: TeleporterHooks) {}

  /** The partner when it is in this sector and still exists. */
  partnerOf(rec: StructureRecord): StructureRecord | null {
    const p = rec.tpPartner;
    if (p === undefined || p.sectorKey !== (this.h.sectorKey() ?? '')) return null;
    for (const r of this.h.registry.all()) if (r.uid === p.uid && isTeleporterKind(r.kind)) return r;
    return null;
  }

  /** The charge this teleporter's jump needs (0 when unpaired). */
  required(rec: StructureRecord): number {
    const p = this.partnerOf(rec);
    if (p === null) return 0;
    return jumpCharge(jumpDistance(0, rec.x, rec.y, p.x, p.y));
  }

  isCharged(rec: StructureRecord): boolean {
    const req = this.required(rec);
    return req > 0 && (rec.tpCharge ?? 0) >= req;
  }

  /** Grid hook: share `spare` power among the component's paired, built,
   *  not-yet-full teleporters. Returns how much was used. */
  chargeCapacitors(members: readonly string[], spare: number): number {
    let count = 0;
    for (const id of members) {
      const r = this.h.registry.get(id);
      if (r && this.wantsCharge(r)) count++;
    }
    if (count === 0) return 0;
    const share = spare / count;
    let used = 0;
    for (const id of members) {
      const r = this.h.registry.get(id);
      if (!r || !this.wantsCharge(r)) continue;
      const need = this.required(r) - (r.tpCharge ?? 0);
      const add = Math.min(need, share);
      r.tpCharge = (r.tpCharge ?? 0) + add;
      used += add;
    }
    return used;
  }

  private wantsCharge(r: StructureRecord): boolean {
    return isTeleporterKind(r.kind) && r.isConstructed && (r.tpCharge ?? 0) < this.required(r);
  }

  /** Pair two of one owner's teleporters (same sector). */
  pair(a: StructureRecord, b: StructureRecord): boolean {
    if (a === b || a.owner !== b.owner || !isTeleporterKind(a.kind) || !isTeleporterKind(b.kind)) return false;
    if (a.uid === undefined || b.uid === undefined) return false;
    if (this.busy(a) || this.busy(b)) return false;
    this.unpair(a);
    this.unpair(b);
    const sector = this.h.sectorKey() ?? '';
    a.tpPartner = { sectorKey: sector, uid: b.uid };
    b.tpPartner = { sectorKey: sector, uid: a.uid };
    this.h.onChanged();
    return true;
  }

  unpair(a: StructureRecord): void {
    const p = this.partnerOf(a);
    if (p !== null && p.tpPartner?.uid === a.uid) this.clearPartner(p);
    this.clearPartner(a);
    this.h.onChanged();
  }

  private clearPartner(r: StructureRecord): void {
    delete r.tpPartner;
    r.tpPhase = TP_PHASE.IDLE;
    r.tpInitiator = false;
    this.applyPhaseEffects(r);
  }

  private busy(r: StructureRecord): boolean {
    return (r.tpPhase ?? TP_PHASE.IDLE) !== TP_PHASE.IDLE;
  }

  setRules(rec: StructureRecord, rules: TeleportRules): void {
    rec.tpRules = { ...rules };
    this.h.onChanged();
  }

  /** Fire now (Manual, or a rule). Needs a present, idle partner, power and charge. */
  fire(rec: StructureRecord, nowMs: number): boolean {
    const p = this.partnerOf(rec);
    if (p === null || this.busy(rec) || this.busy(p)) return false;
    if (!rec.isConstructed || !this.h.isPowered(rec) || !this.isCharged(rec)) return false;
    armCycle(this.cycle, nowMs, this.h.cycleScale());
    for (const r of [rec, p]) {
      r.tpPhase = this.cycle.phase;
      r.tpPhaseEndsAtMs = this.cycle.phaseEndsAtMs;
      r.tpInitiator = false;
    }
    rec.tpInitiator = true;
    this.h.onChanged();
    return true;
  }

  /** T2 — the physical side of a phase: the closing push while CLOSING, the
   *  solid iris while SEALED, neither otherwise. */
  private applyPhaseEffects(r: StructureRecord): void {
    const p = r.tpPhase ?? TP_PHASE.IDLE;
    this.h.setPadField?.(r, p === TP_PHASE.CLOSING);
    this.h.setIrisActive?.(r, p === TP_PHASE.SEALED);
  }

  /** ~10 Hz: run cycles (driven by the initiator) and check the rules. */
  update(nowMs: number): void {
    for (const rec of this.h.registry.all()) {
      if (!isTeleporterKind(rec.kind) || !rec.isConstructed) continue;
      if (rec.tpIrisSpawned !== true) {
        this.h.spawnIris?.(rec);
        rec.tpIrisSpawned = true;
      }
      if (this.busy(rec)) {
        if (rec.tpInitiator === true) this.advance(rec, nowMs);
        continue;
      }
      // "When a ship boards": how long a ship has sat on the pad.
      if (this.h.shipsOnPad(rec) > 0) rec.tpBoardedSinceMs ??= nowMs;
      else delete rec.tpBoardedSinceMs;
      const rules = rec.tpRules ?? DEFAULT_TELEPORT_RULES;
      if (!rules.whenCharged && !rules.shipBoards && rules.loaded === null) continue;
      const pad = rec.padHold;
      const fireNow = rulesSayFire(rules, {
        charged: this.isCharged(rec) && this.h.isPowered(rec),
        boardedForMs: rec.tpBoardedSinceMs === undefined ? 0 : nowMs - rec.tpBoardedSinceMs,
        padGoods: pad?.goods ?? EMPTY_GOODS,
        padWeight: pad === undefined ? 0 : holdWeight(pad),
      });
      if (fireNow) this.fire(rec, nowMs);
    }
  }

  private advance(a: StructureRecord, nowMs: number): void {
    const b = this.partnerOf(a);
    this.cycle.phase = a.tpPhase ?? TP_PHASE.IDLE;
    this.cycle.phaseEndsAtMs = a.tpPhaseEndsAtMs ?? nowMs;
    if (b === null) {
      // The partner vanished mid-cycle: stand down.
      a.tpPhase = TP_PHASE.IDLE;
      a.tpInitiator = false;
      this.applyPhaseEffects(a);
      this.h.onChanged();
      return;
    }
    const before = this.cycle.phase;
    const ev = stepCycle(this.cycle, nowMs, this.h.cycleScale());
    if (this.cycle.phase === before) return;
    if (ev === 'swap') {
      const req = this.required(a);
      if ((a.tpCharge ?? 0) >= req) {
        a.tpCharge = (a.tpCharge ?? 0) - req;
        this.h.storage.padSwap(a, b);
        a.tpArrived = true;
        b.tpArrived = true;
        this.h.onSwapShips?.(a, b);
      }
    }
    for (const r of [a, b]) {
      r.tpPhase = this.cycle.phase;
      r.tpPhaseEndsAtMs = this.cycle.phaseEndsAtMs;
      this.applyPhaseEffects(r);
    }
    if (ev === 'done') a.tpInitiator = false;
    this.h.onChanged();
  }

  /** 1 Hz: unload arrivals into storage, then top a "keep loaded" pad up. */
  pulse(): void {
    for (const rec of this.h.registry.all()) {
      if (!isTeleporterKind(rec.kind) || !rec.isConstructed || this.busy(rec)) continue;
      if (rec.tpArrived === true) {
        this.h.storage.padUnload(rec);
        rec.tpArrived = false;
      }
      const keep = rec.tpRules?.keepLoaded;
      if (keep) {
        const have = rec.padHold?.goods[keep.good] ?? 0;
        if (have < keep.qty) this.h.storage.padLoad(rec, keep.good, keep.qty - have, PAD_SPECS[rec.kind].padCapacity);
      }
    }
  }

  /** A teleporter left the world: its partner is unpaired. */
  onRemoved(rec: StructureRecord): void {
    if (!isTeleporterKind(rec.kind)) return;
    if (rec.tpIrisSpawned === true) this.h.removeIris?.(rec);
    const p = this.partnerOf(rec);
    if (p !== null) {
      this.clearPartner(p);
      this.h.onChanged();
    }
  }
}
