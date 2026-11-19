/**
 * Teleporters (plan soft-leaping-truffle v4, T1–T3): capacitors, pairing,
 * firing rules, the jump cycle and the swap. One instance per SectorRoom.
 *
 *  - CHARGE: spare grid power left after the batteries fill tops up each
 *    paired teleporter's capacitor to the charge its jump needs
 *    (`jumpCharge(distance)`; distance is all that matters: in-sector the pad
 *    distance, across sectors the hop count).
 *  - FIRE: a pad fires when its owner presses Fire or one of its rules is met
 *    (when charged / when loaded / when a ship boards), if it is charged and
 *    both pads are idle.
 *  - CYCLE: both pads arm, close, seal, swap and open together; the end that
 *    fired drives the cycle (for both rooms, T3) and spends its charge at the
 *    swap.
 *  - PULSE (1 Hz): goods that just arrived unload into base storage, then a
 *    "keep loaded" rule tops the pad back up.
 *
 * A partner is a LINK: a teleporter in this room, or (T3) in another
 * sector's room, reached through `remoteFind`.
 *
 * ALIEN GATES (v4 A) are teleporters too, with three differences: they cost
 * nothing (no capacitor, no grid), their cycle runs at
 * `ALIEN_GATE_CYCLE_SCALE`, and they fire on a timetable (every
 * `ALIEN_GATE_INTERVAL_MS`, at a per-pair offset), driven by the end in the
 * lower sector key so the twins fire once, together. They carry ships only.
 */
import {
  ALIEN_GATE_CYCLE_SCALE,
  ALIEN_GATE_INTERVAL_MS,
  alienGateOffsetMs,
  isAlienGateKind,
  isFreeTeleporterKind,
  isTeleporterKind,
  jumpCharge,
  jumpDistance,
  nextAlienGateJumpMs,
  PAD_SPECS,
  TP_PHASE,
  type TeleportRules,
} from '../../shared-types/teleport.js';
import { DEFAULT_TELEPORT_RULES } from '../../shared-types/teleport.js';
import { holdWeight } from '../../core/cargo/hold.js';
import { armCycle, rulesSayFire, stepCycle, type CycleState } from '../../core/structures/teleportCycle.js';
import type { StorageService } from '../cargo/StorageService.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';
import type { Logger } from 'pino';
import { ALIEN_GATE_OWNER, alienGateCandidates, type AlienGateSite } from '../../core/galaxy/alienGates.js';
import { pocketPadPair, POCKET_PAD_OWNER } from '../../core/galaxy/sectorSites.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { AlienGateGuard } from './AlienGateGuard.js';
import type { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { getTeleportBroker } from '../teleport/TeleportBroker.js';
import { linkEnds } from '../../core/bases/transitNetwork.js';

/** A teleporter's partner, local or in another sector's room. */
export interface PartnerLink {
  rec: StructureRecord;
  sys: TeleporterSubsystem;
  /** 0 in the same sector; the hop count across sectors. */
  hops: number;
  remote: boolean;
}

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
  /** T2 — move the ships on the two pads at an in-sector swap. */
  onSwapShips?(a: StructureRecord, b: StructureRecord): void;
  /** T3 — a cross-sector swap: trade the pad holds and send the riders both ways. */
  onSwapRemote?(a: StructureRecord, link: PartnerLink): void;
  /** T3 — a teleporter in another sector (null when unknown or gone). */
  remoteFind?(sectorKey: string, uid: string): { rec: StructureRecord; sys: TeleporterSubsystem } | null;
  /** T3 — hops from this sector to another (Infinity when unreachable). */
  hopsTo?(sectorKey: string): number;
  /** v4 A — the twin of an alien gate, in its neighbour's room (null until
   *  that room is up). */
  findAlienTwin?(rec: StructureRecord): { sectorKey: string; uid: string } | null;
  /** v4 H — the other end of an NPC transit link (null until its room is up). */
  findLinkTwin?(rec: StructureRecord): { sectorKey: string; uid: string } | null;
  /** T4 — a pad armed: offer its toll to the riders on it. */
  onArmed?(rec: StructureRecord): void;
  /** T4 — the swap is now: settle the pad's toll (payers ride free; dodgers
   *  lose standing or become hostile). */
  onTollSettle?(rec: StructureRecord): void;
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

  private here(): string {
    return this.h.sectorKey() ?? '';
  }

  /** The partner when it is in THIS sector and still exists. */
  partnerOf(rec: StructureRecord): StructureRecord | null {
    const p = rec.tpPartner;
    if (p === undefined || p.sectorKey !== this.here()) return null;
    return this.byUid(p.uid);
  }

  /** A built teleporter in this room by structure uid. */
  byUid(uid: string): StructureRecord | null {
    for (const r of this.h.registry.all()) if (r.uid === uid && isTeleporterKind(r.kind)) return r;
    return null;
  }

  /** The partner, local or remote, with its subsystem and hop count. */
  link(rec: StructureRecord): PartnerLink | null {
    const p = rec.tpPartner;
    if (p === undefined) return null;
    if (p.sectorKey === this.here()) {
      const r = this.byUid(p.uid);
      return r ? { rec: r, sys: this, hops: 0, remote: false } : null;
    }
    const found = this.h.remoteFind?.(p.sectorKey, p.uid) ?? null;
    if (found === null) return null;
    const hops = this.h.hopsTo?.(p.sectorKey) ?? Infinity;
    return Number.isFinite(hops) ? { ...found, hops, remote: true } : null;
  }

  /** The charge this teleporter's jump needs (0 when unpaired or unreachable,
   *  and always 0 for an alien gate: they are free). */
  required(rec: StructureRecord): number {
    if (isFreeTeleporterKind(rec.kind)) return 0;
    const l = this.link(rec);
    if (l === null) return 0;
    return jumpCharge(jumpDistance(l.hops, rec.x, rec.y, l.rec.x, l.rec.y));
  }

  isCharged(rec: StructureRecord): boolean {
    if (isFreeTeleporterKind(rec.kind)) return true;
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
    return isTeleporterKind(r.kind) && !isFreeTeleporterKind(r.kind) && r.isConstructed && (r.tpCharge ?? 0) < this.required(r);
  }

  /** Pair with one of the same owner's teleporters, here or (T3) in another
   *  sector's room (`otherSys`). `consented` (T4): both owners agreed, so the
   *  two may belong to different owners. */
  pair(a: StructureRecord, b: StructureRecord, otherSys: TeleporterSubsystem = this, consented = false): boolean {
    if (a === b || !isTeleporterKind(a.kind) || !isTeleporterKind(b.kind)) return false;
    if (!consented && a.owner !== b.owner) return false;
    if (a.uid === undefined || b.uid === undefined) return false;
    if (this.busy(a) || otherSys.busy(b)) return false;
    this.unpair(a);
    otherSys.unpair(b);
    a.tpPartner = { sectorKey: otherSys.here(), uid: b.uid };
    b.tpPartner = { sectorKey: this.here(), uid: a.uid };
    this.h.onChanged();
    if (otherSys !== this) otherSys.changed();
    return true;
  }

  unpair(a: StructureRecord): void {
    const l = this.link(a);
    if (l !== null && l.rec.tpPartner?.uid === a.uid) {
      l.sys.clearPartner(l.rec);
      if (l.sys !== this) l.sys.changed();
    }
    this.clearPartner(a);
    this.h.onChanged();
  }

  /** Re-sync room state (called by another room's subsystem). */
  changed(): void {
    this.h.onChanged();
  }

  private clearPartner(r: StructureRecord): void {
    delete r.tpPartner;
    r.tpPhase = TP_PHASE.IDLE;
    r.tpInitiator = false;
    this.applyPhaseEffects(r);
  }

  busy(r: StructureRecord): boolean {
    return (r.tpPhase ?? TP_PHASE.IDLE) !== TP_PHASE.IDLE;
  }

  setRules(rec: StructureRecord, rules: TeleportRules): void {
    rec.tpRules = { ...rules };
    this.h.onChanged();
  }

  /** Set a teleporter's phase from the cycle (its own room's side effects). */
  setPhase(r: StructureRecord, phase: TeleportPhaseValue, endsAtMs: number): void {
    r.tpPhase = phase;
    r.tpPhaseEndsAtMs = endsAtMs;
    this.applyPhaseEffects(r);
    if (phase === TP_PHASE.ARMED) this.h.onArmed?.(r);
    this.h.onChanged();
  }

  /** T4 — settle this room's pad's toll (called for both ends at the swap). */
  settleToll(r: StructureRecord): void {
    this.h.onTollSettle?.(r);
  }

  /** Fire now (Manual, or a rule). Needs a present, idle partner, power and charge. */
  fire(rec: StructureRecord, nowMs: number): boolean {
    const l = this.link(rec);
    if (l === null || this.busy(rec) || l.sys.busy(l.rec)) return false;
    const free = isFreeTeleporterKind(rec.kind); // alien gates + transit pads: no grid, no charge
    if (!rec.isConstructed || (!free && (!this.h.isPowered(rec) || !this.isCharged(rec)))) return false;
    armCycle(this.cycle, nowMs, this.scaleFor(rec));
    rec.tpInitiator = true;
    l.rec.tpInitiator = false;
    this.setPhase(rec, this.cycle.phase, this.cycle.phaseEndsAtMs);
    l.sys.setPhase(l.rec, this.cycle.phase, this.cycle.phaseEndsAtMs);
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
      if (isAlienGateKind(rec.kind)) {
        this.alienTimetable(rec, nowMs);
        continue;
      }
      // v4 H — an NPC transit teleporter finds its partner by link id.
      if (rec.npcLink !== undefined && rec.tpPartner === undefined) {
        const twin = this.h.findLinkTwin?.(rec) ?? null;
        if (twin === null) continue;
        rec.tpPartner = twin;
        this.h.onChanged();
      }
      // "When a ship boards": how long a ship has sat on the pad.
      if (this.h.shipsOnPad(rec) > 0) rec.tpBoardedSinceMs ??= nowMs;
      else delete rec.tpBoardedSinceMs;
      const rules = rec.tpRules ?? DEFAULT_TELEPORT_RULES;
      if (!rules.whenCharged && !rules.shipBoards && rules.loaded === null) continue;
      const pad = rec.padHold;
      const fireNow = rulesSayFire(rules, {
        charged: this.isCharged(rec) && (isFreeTeleporterKind(rec.kind) || this.h.isPowered(rec)),
        boardedForMs: rec.tpBoardedSinceMs === undefined ? 0 : nowMs - rec.tpBoardedSinceMs,
        padGoods: pad?.goods ?? EMPTY_GOODS,
        padWeight: pad === undefined ? 0 : holdWeight(pad),
      });
      if (fireNow) this.fire(rec, nowMs);
    }
  }

  /** Cycle speed for this pad: alien gates run quicker than built ones. */
  private scaleFor(rec: StructureRecord): number {
    return isAlienGateKind(rec.kind) ? this.h.cycleScale() * ALIEN_GATE_CYCLE_SCALE : this.h.cycleScale();
  }

  /** An idle alien gate: fire when its timetable says so. Only the end in
   *  the lower sector key fires (its twin then runs the same cycle). The
   *  test speed-up (`cycleScale`) shortens the interval too. */
  private alienTimetable(rec: StructureRecord, nowMs: number): void {
    if (rec.tpPartner === undefined) {
      const twin = this.h.findAlienTwin?.(rec) ?? null;
      if (twin === null) return;
      rec.tpPartner = twin;
      this.h.onChanged();
    }
    const p = rec.tpPartner;
    const here = this.here();
    const interval = ALIEN_GATE_INTERVAL_MS * this.h.cycleScale();
    const offset = alienGateOffsetMs(here, p.sectorKey) * this.h.cycleScale();
    if (rec.tpNextJumpMs === undefined) {
      rec.tpNextJumpMs = nextAlienGateJumpMs(nowMs, offset, interval);
      return;
    }
    if (nowMs < rec.tpNextJumpMs) return;
    rec.tpNextJumpMs = nextAlienGateJumpMs(nowMs, offset, interval);
    if (here < p.sectorKey) this.fire(rec, nowMs);
  }

  /** When this alien gate next jumps (ms since epoch), if known. */
  nextJumpAt(rec: StructureRecord): number | undefined {
    return rec.tpNextJumpMs;
  }

  private advance(a: StructureRecord, nowMs: number): void {
    const l = this.link(a);
    this.cycle.phase = a.tpPhase ?? TP_PHASE.IDLE;
    this.cycle.phaseEndsAtMs = a.tpPhaseEndsAtMs ?? nowMs;
    if (l === null) {
      // The partner vanished mid-cycle: stand down.
      a.tpInitiator = false;
      this.setPhase(a, TP_PHASE.IDLE, 0);
      return;
    }
    const before = this.cycle.phase;
    const ev = stepCycle(this.cycle, nowMs, this.scaleFor(a));
    if (this.cycle.phase === before) return;
    if (ev === 'swap') {
      const req = this.required(a);
      if ((a.tpCharge ?? 0) >= req) {
        a.tpCharge = (a.tpCharge ?? 0) - req;
        this.settleToll(a);
        l.sys.settleToll(l.rec);
        if (l.remote) {
          this.h.onSwapRemote?.(a, l);
        } else {
          this.h.storage.padSwap(a, l.rec);
          this.h.onSwapShips?.(a, l.rec);
        }
        a.tpArrived = true;
        l.rec.tpArrived = true;
      }
    }
    this.setPhase(a, this.cycle.phase, this.cycle.phaseEndsAtMs);
    l.sys.setPhase(l.rec, this.cycle.phase, this.cycle.phaseEndsAtMs);
    if (ev === 'done') a.tpInitiator = false;
  }

  /** 1 Hz: unload arrivals into storage, then top a "keep loaded" pad up. */
  pulse(): void {
    for (const rec of this.h.registry.all()) {
      if (!isTeleporterKind(rec.kind) || !rec.isConstructed || this.busy(rec)) continue;
      if (isFreeTeleporterKind(rec.kind)) continue; // ships only: no pad hold
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

  /** A teleporter left the world: its partner (here or elsewhere) is unpaired. */
  onRemoved(rec: StructureRecord): void {
    if (!isTeleporterKind(rec.kind)) return;
    if (rec.tpIrisSpawned === true) this.h.removeIris?.(rec);
    const l = this.link(rec);
    if (l !== null && l.rec.tpPartner?.uid === rec.uid) {
      l.sys.clearPartner(l.rec);
      l.sys.changed();
    }
  }
}

type TeleportPhaseValue = 0 | 1 | 2 | 3 | 4;

// ── Boot seeding of NPC teleporters (moved verbatim from SectorRoom) ───────

/** What the alien-gate and pocket-pad seeders need from the room; getters
 *  read fields the room assigns in `onCreate`. Built once on the room
 *  (`npcSeedHost`). */
export interface NpcGateSeedHost {
  readonly structureRegistry: StructureRegistry;
  readonly swarmRegistry: Pick<SwarmEntityRegistry, 'all'>;
  readonly gateGuard: Pick<AlienGateGuard, 'addGate'>;
  readonly logger: Pick<Logger, 'warn'>;
  sabF32(): Float32Array;
  structurePlacement(): Pick<StructurePlacementSubsystem, 'place' | 'remove'>;
  teleporters(): Pick<TeleporterSubsystem, 'pair'>;
  swarmHealth(): Pick<Map<string, number>, 'delete'>;
  evictSwarmEntity(rec: SwarmEntityRecord, opts: { broadcast: boolean; emitDestroyed: boolean }): void;
  rebuildStructuresSlice(): void;
}

/**
 * v4 A — seed this sector's alien gates: one per neighbour, near the edge
 * facing it, built and invulnerable (no hull pool; `applyDamage` turns a hit
 * into a disable). Runs AFTER the NPC bases, so a gate takes the nearest
 * free spot to its ideal site (`alienGateCandidates`); asteroids under it are
 * cleared quietly. It remembers its neighbour, and the teleporter subsystem
 * finds the twin across the border through the broker the first time it
 * needs it (`findAlienTwin`). Not persisted (NPC-owned): every boot
 * regenerates them.
 */
export function seedAlienGates(h: NpcGateSeedHost, sectorKey: string, sites: readonly AlienGateSite[]): void {
  const half = getStructureKind('alien_gate').footprint.w / 2;
  for (const site of sites) {
    let placed: string | null = null;
    for (const c of alienGateCandidates(site, half, SECTOR_PLAYABLE_HALF_EXTENT)) {
      let blocked = false;
      for (const r of h.structureRegistry.all()) {
        if (Math.abs(r.x - c.x) < half + (r.halfW ?? r.radius) && Math.abs(r.y - c.y) < half + (r.halfH ?? r.radius)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      for (const rec of [...h.swarmRegistry.all()]) { // TODO: alloc-debt (boot only)
        if (rec.kind !== 0) continue;
        const b = slotBase(rec.slot);
        const dx = Math.abs(h.sabF32()[b + SLOT_X_OFF]! - c.x);
        const dy = Math.abs(h.sabF32()[b + SLOT_Y_OFF]! - c.y);
        if (dx < half + rec.radius && dy < half + rec.radius) h.evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false });
      }
      placed = h.structurePlacement().place(ALIEN_GATE_OWNER, 'alien_gate', c.x, c.y, { skipAutoConnect: true });
      if (placed !== null) break;
    }
    if (placed === null) {
      h.logger.warn({ sectorKey, neighbour: site.neighbour }, 'alien gate: no free spot; gate skipped');
      continue;
    }
    const rec = h.structureRegistry.get(placed)!;
    rec.isConstructed = true;
    rec.constructionProgress = rec.constructionCost;
    rec.alienNeighbour = site.neighbour;
    h.swarmHealth().delete(placed);
    h.gateGuard.addGate(rec);
  }
  h.rebuildStructuresSlice();
}

/**
 * Wrap-up W1b — the system's transit pads: home and one other pocket, if
 * this system has a pair at all (`pocketPadPair`, rare by design). Neutral
 * (Traders-owned), free (no charge, no grid), fire when a ship boards, no
 * toll. Each takes the nearest free spot to its ideal centre. Not persisted
 * (NPC-owned): every boot regenerates them.
 */
export function seedPocketPads(h: NpcGateSeedHost, sectorKey: string): void {
  const pair = pocketPadPair(sectorKey);
  if (pair === null) return;
  const half = getStructureKind('pocket_pad').footprint.w / 2;
  const placeNear = (x: number, y: number): StructureRecord | null => {
    for (let ring = 0; ring < 8; ring++) {
      const steps = ring === 0 ? 1 : ring * 8;
      for (let k = 0; k < steps; k++) {
        const t = (k / steps) * Math.PI * 2;
        const cx = Math.round(x + Math.cos(t) * ring * half * 2.5), cy = Math.round(y + Math.sin(t) * ring * half * 2.5);
        let blocked = false;
        for (const r of h.structureRegistry.all()) {
          if (Math.abs(r.x - cx) < half + (r.halfW ?? r.radius) && Math.abs(r.y - cy) < half + (r.halfH ?? r.radius)) { blocked = true; break; }
        }
        if (blocked) continue;
        const id = h.structurePlacement().place(POCKET_PAD_OWNER, 'pocket_pad', cx, cy, { skipAutoConnect: true });
        if (id !== null) return h.structureRegistry.get(id) ?? null;
      }
    }
    return null;
  };
  const a = placeNear(pair.ax, pair.ay);
  const b = a === null ? null : placeNear(pair.bx, pair.by);
  if (a === null || b === null) {
    h.logger.warn({ sectorKey, to: pair.b.id }, 'pocket pads: no free spot; pads skipped');
    if (a !== null) h.structurePlacement().remove(POCKET_PAD_OWNER, a.id);
    h.rebuildStructuresSlice();
    return;
  }
  for (const rec of [a, b]) {
    rec.isConstructed = true;
    rec.constructionProgress = rec.constructionCost;
    rec.tpRules = { ...DEFAULT_TELEPORT_RULES, shipBoards: true };
    h.swarmHealth().delete(rec.id);
  }
  h.teleporters().pair(a, b);
  h.rebuildStructuresSlice();
}

/** What the gate-twin lookups read from the room (read at call time). */
export interface GateTwinHost {
  sectorKey(): string | null;
  structureRegistry(): StructureRegistry;
}

/** v4 H — the teleporter at the other end of `rec.npcLink` (another sector's
 *  room, found through the broker; it carries the same link id). */
export function findLinkTwin(h: GateTwinHost, rec: StructureRecord): { sectorKey: string; uid: string } | null {
  const id = rec.npcLink;
  const sectorKey = h.sectorKey();
  if (id === undefined || sectorKey === null) return null;
  const ends = linkEnds(id);
  if (ends === null) return null;
  const there = ends[0].sector === sectorKey ? ends[1].sector : ends[0].sector;
  // Both ends in this sector: look here (another instance of a test room may
  // share the sector key in the broker).
  let candidates: Iterable<StructureRecord>;
  if (there === sectorKey) candidates = h.structureRegistry().all();
  else {
    const room = getTeleportBroker().room(there);
    if (room === null) return null;
    candidates = room.structures();
  }
  for (const r of candidates) {
    if (r !== rec && r.npcLink === id && r.uid !== undefined && r.isConstructed) return { sectorKey: there, uid: r.uid };
  }
  return null;
}

/** v4 A — the alien gate in `rec.alienNeighbour`'s room that faces back here. */
export function findAlienTwin(h: GateTwinHost, rec: StructureRecord): { sectorKey: string; uid: string } | null {
  const there = rec.alienNeighbour;
  const sectorKey = h.sectorKey();
  if (there === undefined || sectorKey === null) return null;
  const room = getTeleportBroker().room(there);
  if (room === null) return null;
  for (const g of room.ownTeleporters(ALIEN_GATE_OWNER)) {
    if (g.alienNeighbour === sectorKey && g.uid !== undefined) return { sectorKey: there, uid: g.uid };
  }
  return null;
}
