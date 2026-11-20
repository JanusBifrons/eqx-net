/**
 * Auto-deposit and the crane bays (moved out of SectorRoom.ts): the hover
 * drop-off dwell (Living World P1a-2), the freight dock / Capital crane bay
 * cycle (structure-restyle 3b / 3d / 3e / 3i) and convoy haulers' crane
 * jobs (3h). Owned by `SectorRoom`, which runs `tick()` every 6 ticks and
 * reads `progressOf` for the own-ship slice.
 *
 * Docs: docs/features/loot-and-cargo.md, docs/architecture/server-thresholds.md.
 */
import { CRANE_CARGO_IN, CRANE_CARGO_OUT, craneCargoReadout } from '../../../core/articulation/craneCargo.js';
import { DOCK_CRANE_REACH_TICKS, DOCK_SETTLE_TICKS, PACK_CLIP, UNFOLD_CLIP, craneBayFor, dockUnloadHoldTicks, isStillForDock, onStructureCraneBay, unfoldBusy } from '../../../core/articulation/rigCatalogue.js';
import { holdWeight, isHoldEmpty } from '../../../core/cargo/hold.js';
import type { Hold } from '../../../shared-types/goods.js';
import { DEPOSIT_FLOW_STEP, DEPOSIT_WAITING } from '../../../shared-types/messages/snapshotMessages.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import type { LootCollector } from '../../cargo/LootSubsystem.js';
import type { LootCollectors } from '../../cargo/LootCollectors.js';
import type { StorageService } from '../../cargo/StorageService.js';
import { holdHasIntake, holdIntakeWeight, isOperationalStorage } from '../../cargo/storageHolds.js';
import { DEPOSIT_DWELL_TICKS } from '../../cargo/storageReach.js';
import type { CraneHaulJob } from '../../economy/convoyRoom.js';
import { dockIntakeGoods, type StructureRecord, type StructureRegistry } from '../../structures/StructureRegistry.js';
import { craneGripTarget, rigClipTip } from '../../structures/structureRigClip.js';

/** One auto-deposit dwell (`CraneBays.depositDwell`). `phase` is set only on
 *  a freight dock's bay (structure-restyle 3b); absent = the plain hover dwell. */
interface DepositDwell {
  targetId: string;
  sinceTick: number;
  shipId: string;
  phase?: 'settle' | 'reach' | 'hold' | 'done';
  /** Tick the current crane clip (reach / hold) started. */
  clipTick?: number;
  /** Clamp hold length (`dockUnloadHoldTicks`), fixed at reach start. */
  holdTicks?: number;
  /** 3e: which way the cargo goes during the hold (`CRANE_CARGO_*`). */
  cargo?: number;
  /** Last autoDepositTick this ship was visited: a crane claim whose ship
   *  vanished (left, died) is released by the sweep. */
  seenTick?: number;
}

/** What the crane bays read from the room (getters for fields it assigns late). */
export interface CraneBayHost {
  structures(): Pick<StructureRegistry, 'get' | 'all' | 'size'>;
  readonly lootCollectors: Pick<LootCollectors, 'forEach' | 'fillShip'>;
  /** C1 — pilots who moved cargo by hand (no auto-deposit until they leave). */
  readonly manualCargo: Set<string>;
  serverTick(): number;
  storage(): Pick<StorageService, 'nearestOwnStorage' | 'nearestHoverDropOff' | 'deposit' | 'loadOutlet' | 'outletLoadWeight'>;
  shipHold(shipInstanceId: string): Hold | undefined;
  /** Cargo pods 14c — the ship's auto-unload switch (default on). */
  autoUnloadOn(shipInstanceId: string): boolean;
  /** `SectorRoom.startStructureRigClip`. */
  startStructureRigClip(
    id: string, clipId: string | null, target?: { readonly x: number; readonly y: number },
    hold?: { readonly holdTicks: number; readonly cargo: number },
  ): boolean;
  /** Tell the depositing pilot what moved, and audit it. */
  noteDeposited(c: LootCollector, target: StructureRecord, moved: Hold, loaded?: boolean): void;
}

export class CraneBays {
  /** Auto-deposit dwell: playerId → (target structure id, first in-range tick). */
  /*  A freight dock's bay (structure-restyle 3b) adds the crane phases: settle
   *  (still on the bay) → reach → hold → done (retracting or served; kept
   *  until the ship leaves the bay, so it is not served twice). */
  private readonly depositDwell = new Map<string, DepositDwell>();
  /** structure-restyle 3h — convoy haulers' crane jobs by bot id
   *  (`craneServe`); their dwell rides `depositDwell` under the same id. */
  private readonly haulerCraneJobs = new Map<string, CraneHaulJob>();
  /** Reused collector for a crane-served hauler (`visitCraneHauler`, #14). */
  private readonly haulerCollector: LootCollector = { playerId: '', shipInstanceId: '', x: 0, y: 0, angle: 0, vx: 0, vy: 0, shieldUp: false, capacity: 0, kind: getShipKind(null) };
  /** Auto-deposit progress 0..100 by shipInstanceId (own-ship snapshot ring). */
  private readonly depositProgress = new Map<string, number>();

  constructor(private readonly h: CraneBayHost) {}

  /** Auto-deposit progress 0..100 (or `DEPOSIT_WAITING`) for a ship. */
  progressOf(shipInstanceId: string): number | undefined {
    return this.depositProgress.get(shipInstanceId);
  }

  /**
   * Living World P1a-2 — AUTO-DEPOSIT. A collector (#17: active + alive + roster
   * row) carrying cargo that stays within deposit range (`depositRangeOf`) of its OWN operational
   * storage for `DEPOSIT_DWELL_TICKS` (2 s) deposits its whole hold into that
   * storage network. Progress (0..100) rides the own-ship snapshot slice. Runs
   * every 6 ticks; early-outs when the sector has no structures.
   */
  tick(): void {
    if (this.h.structures().size === 0) {
      if (this.depositDwell.size > 0) { this.depositDwell.clear(); this.depositProgress.clear(); }
      this.haulerCraneJobs.clear();
      this.h.manualCargo.clear();
      return;
    }
    this.h.lootCollectors.forEach(this.visitDepositor);
    // 3h: convoy haulers a dock's crane was asked to serve.
    if (this.haulerCraneJobs.size > 0) this.haulerCraneJobs.forEach(this.visitCraneHauler);
    // 3b: a crane claim whose ship was not visited this pass (left the room,
    // died, swapped hulls) retracts the arm and frees the dock.
    if (this.depositDwell.size > 0) this.depositDwell.forEach(this.sweepDepositDwell);
  }

  /** Bound once (no per-tick closure allocation, #14). */
  private readonly sweepDepositDwell = (d: DepositDwell, pid: string): void => {
    if ((d.phase === 'reach' || d.phase === 'hold') && d.seenTick !== this.h.serverTick()) {
      const dock = this.h.structures().get(d.targetId);
      if (dock) this.retractDockCrane(dock);
      this.depositDwell.delete(pid);
      this.depositProgress.delete(d.shipId);
    }
  };

  /** 3h: a convoy hauler with a crane job (`craneServe`) runs the same bay
   *  dwell as a player ship while its centre is on that dock's bay; off the
   *  bay any crane claim aborts (the arm retracts, nothing moves) and the job
   *  waits for it to come back. A hauler gone from the room drops its job.
   *  Bound once (no per-tick closure allocation, #14). */
  private readonly visitCraneHauler = (job: CraneHaulJob, botId: string): void => {
    const c = this.haulerCollector;
    const dock = this.h.structures().get(job.dockId);
    if (!this.h.lootCollectors.fillShip(botId, c) || dock === undefined || !isOperationalStorage(dock)) {
      this.haulerCraneJobs.delete(botId);
      this.dropDepositDwell(botId);
      return;
    }
    if (onStructureCraneBay(dock.kind, dock.x, dock.y, dock.rot ?? 0, c.x, c.y)) this.dockDwell(c, dock, undefined, job);
    else this.dropDepositDwell(botId);
  };

  /** Bound once (no per-tick closure allocation, #14). */
  private readonly visitDepositor = (c: LootCollector): void => {
    const storage = this.h.storage();
    if (this.h.manualCargo.has(c.playerId)) {
      // Moved cargo by hand: no auto-deposit until they leave their storage
      // (its reach, or its crane bay: a Capital's bay lies past 400 u).
      if (storage.nearestOwnStorage(c.playerId, c.x, c.y) === null) {
        this.h.manualCargo.delete(c.playerId);
      }
      this.dropDepositDwell(c.playerId);
      return;
    }
    const hold = this.h.shipHold(c.shipInstanceId);
    // 3b / 3i: a ship on its own crane bay (a freight dock's or the Capital's)
    // belongs to that bay (stop = go). Off a bay, only a hover drop-off
    // (`takesHoverDeposit`: no crane bay, e.g. a Cargo Bay) banks a ship
    // holding near it (3f: crane-bay kinds never take the hover deposit).
    const bayDock = this.ownDockBayAt(c.playerId, c.x, c.y);
    if (bayDock !== null) { this.dockDwell(c, bayDock, hold); return; }
    // Cargo pods 14c: both ends must agree (the ship's switch here, the
    // storage's accept in `nearestHoverDropOff`).
    const target = hold !== undefined && !isHoldEmpty(hold) && this.h.autoUnloadOn(c.shipInstanceId)
      ? storage.nearestHoverDropOff(c.playerId, c.x, c.y)
      : null;
    if (target === null) {
      this.dropDepositDwell(c.playerId);
      return;
    }
    const tick = this.h.serverTick();
    const dwell = this.depositDwell.get(c.playerId);
    if (dwell === undefined || dwell.targetId !== target.id || dwell.phase !== undefined) {
      this.dropDepositDwell(c.playerId);
      this.depositDwell.set(c.playerId, { targetId: target.id, sinceTick: tick, shipId: c.shipInstanceId });
      this.depositProgress.set(c.shipInstanceId, 0);
      return;
    }
    const elapsed = tick - dwell.sinceTick;
    if (elapsed < DEPOSIT_DWELL_TICKS) {
      this.depositProgress.set(c.shipInstanceId, Math.floor((elapsed / DEPOSIT_DWELL_TICKS) * 100));
      return;
    }
    const moved = storage.deposit(c.shipInstanceId, c.playerId, target);
    this.depositDwell.delete(c.playerId);
    this.depositProgress.delete(c.shipInstanceId);
    this.h.noteDeposited(c, target, moved);
  };

  /**
   * structure-restyle 3b — "stop = go" on a crane bay. A ship whose
   * centre is on the bay (`inCraneBay`) and still (`isStillForDock`) settles
   * for `DOCK_SETTLE_TICKS`; then the crane reaches for it (`arm-reach`),
   * clamps on (`arm-hold`) for `dockUnloadHoldTicks(load, capacity)`, banks
   * the dock's intake (`dockIntakeGoods`) at hold END, then (3d) loads its
   * export goods from base storage (`StorageService.loadOutlet`), and
   * retracts: one cycle serves a mixed dock, unload first. Moving or
   * leaving during reach / hold aborts: the arm retracts from where it is and
   * nothing is banked. One ship per crane, first come first served: a second
   * settled ship waits (`DEPOSIT_WAITING` on its readout, 3e) until the arm
   * is back at rest. 3i: the Capital's built-in bay runs the same cycle; it
   * never has freight orders (only docks take them), so it takes everything
   * and loads nothing. 3h: a convoy hauler (`job`, keyed by its bot id) is
   * served the same way, one ship per crane with the players; its job fixes
   * the cargo direction and weight, and its trade (`job.atHoldEnd`) runs
   * at hold END in place of the bank / load; then the dwell is over.
   */
  private dockDwell(c: LootCollector, dock: StructureRecord, hold: Hold | undefined, job?: CraneHaulJob): void {
    const tick = this.h.serverTick();
    const storage = this.h.storage();
    let d = this.depositDwell.get(c.playerId);
    if (d !== undefined && d.targetId !== dock.id) { this.dropDepositDwell(c.playerId); d = undefined; }
    const still = isStillForDock(c.vx, c.vy);
    if (d?.phase === 'done') return; // served: nothing more until it leaves the bay
    if (d?.phase === 'reach' || d?.phase === 'hold') {
      d.seenTick = tick;
      if (!still) { this.dropDepositDwell(c.playerId); return; }
      if (d.phase === 'reach') {
        if (tick - d.clipTick! < DOCK_CRANE_REACH_TICKS) { this.setDockProgress(d, tick); return; }
        d.phase = 'hold';
        d.clipTick = tick;
        this.h.startStructureRigClip(dock.id, 'arm-hold', dock.rigClip?.target, { holdTicks: d.holdTicks!, cargo: d.cargo ?? 0 });
      }
      if (tick - d.clipTick! < d.holdTicks!) { this.setDockProgress(d, tick); return; }
      if (job !== undefined) {
        this.h.startStructureRigClip(dock.id, 'arm-retract', dock.rigClip?.target);
        this.depositDwell.delete(c.playerId);
        this.depositProgress.delete(c.shipInstanceId);
        this.haulerCraneJobs.delete(c.playerId);
        job.atHoldEnd();
        return;
      }
      const moved = storage.deposit(c.shipInstanceId, c.playerId, dock, dockIntakeGoods(dock));
      const after = this.h.shipHold(c.shipInstanceId);
      const loaded = storage.loadOutlet(c.shipInstanceId, c.playerId, dock, c.capacity - (after ? holdWeight(after) : 0));
      this.h.startStructureRigClip(dock.id, 'arm-retract', dock.rigClip?.target);
      d.phase = 'done';
      this.depositProgress.delete(c.shipInstanceId);
      this.h.noteDeposited(c, dock, moved);
      this.h.noteDeposited(c, dock, loaded, true);
      return;
    }
    // No crane yet. Nothing to unload AND nothing to load ⇒ no dwell at all
    // (no bar that restarts forever): a hold with none of the import goods
    // and no room for (or no spare) export goods.
    if (!still) { this.dropDepositDwell(c.playerId); return; }
    let unloadW: number;
    let loadW: number;
    if (job !== undefined) {
      unloadW = job.cargo === 'unload' ? job.weight : -1;
      loadW = job.cargo === 'load' ? job.weight : 0;
    } else {
      // Cargo pods 14c: the crane unloads only when the ship's switch and the
      // dock's accept both allow auto-unload; loading export goods is unaffected.
      const unloadOk = hold !== undefined && dock.acceptAutoUnload !== false && this.h.autoUnloadOn(c.shipInstanceId);
      const intake = unloadOk ? dockIntakeGoods(dock) : undefined;
      unloadW = unloadOk && holdHasIntake(hold, intake) ? holdIntakeWeight(hold, intake) : -1;
      loadW = storage.outletLoadWeight(dock, c.capacity - (hold ? holdWeight(hold) : 0) + Math.max(0, unloadW));
    }
    if (unloadW < 0 && !(loadW > 0)) { this.dropDepositDwell(c.playerId); return; }
    const cargo = (unloadW >= 0 ? CRANE_CARGO_IN : 0) | (loadW > 0 ? CRANE_CARGO_OUT : 0);
    if (d === undefined) {
      this.depositDwell.set(c.playerId, { targetId: dock.id, sinceTick: tick, shipId: c.shipInstanceId, phase: 'settle' });
      // The readout says which way the goods will go from the start (unload first).
      this.depositProgress.set(c.shipInstanceId, craneCargoReadout(0, 0, cargo, DEPOSIT_FLOW_STEP));
      return;
    }
    // Settling: progress 0. Waiting for the crane (another ship's cycle):
    // the readout says so (3e), not a stuck 0 % bar.
    if (tick - d.sinceTick < DOCK_SETTLE_TICKS) return;
    if (this.dockCraneBusy(dock)) { this.depositProgress.set(c.shipInstanceId, DEPOSIT_WAITING); return; }
    if (!this.h.startStructureRigClip(dock.id, 'arm-reach', craneGripTarget(dock, c.x, c.y, c.angle, c.kind.id))) return;
    d.phase = 'reach';
    d.clipTick = tick;
    d.seenTick = tick;
    d.holdTicks = dockUnloadHoldTicks(Math.max(0, unloadW) + loadW, c.capacity);
    d.cargo = cargo;
    this.setDockProgress(d, tick);
  }

  /** Own-ship readout over reach + hold (`craneCargoReadout`): which way the
   *  goods go and how far through that move (0 while the arm reaches). The
   *  goods move in one trade at hold end; the HUD drains an unload, fills a load. */
  private setDockProgress(d: DepositDwell, tick: number): void {
    const elapsed = d.phase === 'hold' ? tick - d.clipTick! : 0;
    this.depositProgress.set(d.shipId, craneCargoReadout(elapsed, d.holdTicks!, d.cargo ?? 0, DEPOSIT_FLOW_STEP));
  }

  /** The arm is out (reaching, holding, or still retracting). */
  private dockCraneBusy(dock: StructureRecord): boolean {
    const p = dock.rigClip;
    if (p === undefined || p === null) return false;
    // Unfolding from its crate (or packing): busy until that has played.
    if (p.clipId === UNFOLD_CLIP || p.clipId === PACK_CLIP) return unfoldBusy(p, this.h.serverTick());
    return p.clipId !== 'arm-retract' || this.h.serverTick() - p.startTick < DOCK_CRANE_REACH_TICKS;
  }

  /** Abort: retract from the arm's current tip (mid-reach) or its target (holding). */
  private retractDockCrane(dock: StructureRecord): void {
    const p = dock.rigClip;
    if (p === undefined || p === null || p.clipId === 'arm-retract' || p.clipId === UNFOLD_CLIP || p.clipId === PACK_CLIP) return;
    this.h.startStructureRigClip(dock.id, 'arm-retract', rigClipTip(dock, this.h.serverTick()) ?? p.target);
  }

  /** End `playerId`'s dwell; a live crane claim retracts the arm (abort). */
  private dropDepositDwell(playerId: string): void {
    const d = this.depositDwell.get(playerId);
    if (d === undefined) return;
    if (d.phase === 'reach' || d.phase === 'hold') {
      const dock = this.h.structures().get(d.targetId);
      if (dock) this.retractDockCrane(dock);
    }
    this.depositDwell.delete(playerId);
    this.depositProgress.delete(d.shipId);
  }

  /** `owner`'s operational crane-bay structure (`craneBayFor`: freight dock,
   *  Capital) whose bay holds world point (x, y) (`onStructureCraneBay`), or null. Alloc-free. */
  private ownDockBayAt(owner: string, x: number, y: number): StructureRecord | null {
    for (const rec of this.h.structures().all()) {
      if (rec.owner !== owner || !isOperationalStorage(rec)) continue;
      if (onStructureCraneBay(rec.kind, rec.x, rec.y, rec.rot ?? 0, x, y)) return rec;
    }
    return null;
  }

  /** 3h — ConvoyRoom: `job.dockId`'s crane serves hauler `botId` (the bay
   *  dwell, `visitCraneHauler` → `dockDwell`). 'none' when that dock can't:
   *  gone, not `job.owner`'s, no crane bay, not operational, or nothing to
   *  load; the convoy then trades atomically. Off-tick (convoy loop). */
  craneServe(botId: string, job: CraneHaulJob): 'serving' | 'none' {
    const dock = this.h.structures().get(job.dockId);
    if (dock === undefined || dock.owner !== job.owner || craneBayFor(dock.kind) === null
      || !isOperationalStorage(dock) || (job.cargo === 'load' && !(job.weight > 0))) {
      this.craneCancel(botId);
      return 'none';
    }
    const had = this.haulerCraneJobs.get(botId);
    if (had !== undefined && had !== job) this.craneCancel(botId);
    this.haulerCraneJobs.set(botId, job);
    return 'serving';
  }

  /** 3h — ConvoyRoom: drop hauler `botId`'s crane job; an arm out retracts. */
  craneCancel(botId: string): void {
    this.haulerCraneJobs.delete(botId);
    this.dropDepositDwell(botId);
  }
}
