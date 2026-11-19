/**
 * A2 (plan soft-leaping-truffle v2) — sync every structure's grid state into
 * ROOM STATE (`state.structures`, delta-patched to clients) and rebuild the
 * slim snapshot targets slice. Fields are assigned only when they change, so
 * an idle base produces no patch bytes. Replaces the pre-A2 slice that sent
 * every row to every client in every 20 Hz snapshot (A0: ~689 KB/s per client
 * at citadel scale). Runs from the 1 Hz pulse, 10 Hz turret tick and
 * placement paths; `SectorRoom.rebuildStructuresSlice` is a one-line delegate.
 *
 * Moved out of `SectorRoom.ts` by god-file split slice 29; the room builds one
 * `StructuresSliceSync` as a class field with a narrow host (getters for the
 * fields it assigns in `onCreate`).
 */
import { StructureState, type SectorState } from './schema/SectorState.js';
import {
  STRUCTURE_ETA_NONE,
  STRUCTURE_ETA_STALLED,
  STRUCTURE_FLAG_BUILT,
  STRUCTURE_FLAG_DECONSTRUCTING,
  STRUCTURE_FLAG_POWERED,
  STRUCTURE_FLAG_WALL_ACTIVE,
  STRUCTURE_FLAG_NO_AMMO,
  STRUCTURE_FLAG_NO_FUEL,
  STRUCTURE_FLAG_DRAW_FULL,
  STRUCTURE_FLAG_BREACH,
  STRUCTURE_TARGET_NONE,
  STRUCTURE_DEFAULTS as SD,
  encodePlayerTurretTarget,
} from '../../shared-types/structureStateWire.js';
import {
  TP_RULE_TOLL_HOSTILE,
  TP_PARTNER_REMOTE,
  TP_RULE_BOARDS,
  TP_RULE_CHARGED,
  TP_RULE_KEEP,
  TP_RULE_LOADED,
  isTeleporterKind,
} from '../../shared-types/teleport.js';
import { isShieldEmitterKind, gateTypeOf } from '../../core/structures/gateGeometry.js';
import { PROD_STATE, encodeBpRuns, encodeGood, encodeRecipe, isProcessorKind } from '../../shared-types/production.js';
import { blueprintQuality } from '../../shared-types/blueprints.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { effectiveStructureMaxHealth } from '../../core/leveling/structureLevel.js';
import { holdWeight } from '../../core/cargo/hold.js';
import type { GameClock } from '../../core/clock/GameClock.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { StructureRecord, StructureRegistry } from '../structures/StructureRegistry.js';
import type { StructureGridSubsystem } from '../structures/StructureGridSubsystem.js';
import type { ShieldWallManager } from '../structures/ShieldWallManager.js';
import type { GateController } from '../structures/GateController.js';
import type { TeleporterSubsystem } from '../structures/TeleporterSubsystem.js';
import type { BreakInSubsystem } from './BreakInSubsystem.js';

/** What the sync reads from the room. Getters for fields the room assigns
 *  in `onCreate` (or reads through a getter of its own). */
export interface StructuresSliceHost {
  state: () => SectorState;
  gameClock: Pick<GameClock, 'now'>;
  structureRegistry: Pick<StructureRegistry, 'all' | 'connectionsOf'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'get'>;
  swarmHealth: () => Map<string, number>;
  breakIns: Pick<BreakInSubsystem, 'breached'>;
  structureGrid: () => Pick<StructureGridSubsystem, 'powerSummaryFor' | 'estimateBuildEtaMs'>;
  shieldWalls: () => Pick<ShieldWallManager, 'wallsUpFor' | 'wallStateFor'>;
  gates: () => Pick<GateController, 'maskFor'>;
  teleporters: () => Pick<TeleporterSubsystem, 'required' | 'partnerOf'>;
  /** The room's owner interning (also used by the mine sync). */
  internStructureOwner: (owner: string) => number;
}

export class StructuresSliceSync {
  /** A2 — entityId key → generation last synced (stale-row sweep, alloc-free). */
  private readonly structureStateGen = new Map<string, number>();
  private structureStateGeneration = 0;

  constructor(private readonly h: StructuresSliceHost) {}

  /** Sync `state.structures` and return the snapshot's slim cosmetic slice
   *  (turret / mining targets only; undefined when nothing has a target). */
  rebuild(): number[] | undefined {
    const h = this.h;
    const map = h.state().structures;
    const gen = ++this.structureStateGeneration;
    let targets: number[] | undefined;
    const nowMs = h.gameClock.now();
    for (const rec of h.structureRegistry.all()) {
      const entityId = h.swarmRegistry.get(rec.id)?.entityId;
      if (entityId === undefined) continue; // swarm entity gone — skip
      const key = rec.stateKey ?? (rec.stateKey = String(entityId));
      let st = map.get(key);
      if (!st) {
        st = new StructureState();
        map.set(key, st);
      }
      this.structureStateGen.set(key, gen);
      const summary = h.structureGrid().powerSummaryFor(rec.id);
      // Hull percent of the LEVELED max (a full-health leveled structure is 100).
      const hpMax = effectiveStructureMaxHealth(getStructureKind(rec.kind).maxHealth, rec.level, rec.packedQuality);
      const hp = h.swarmHealth().get(rec.id) ?? hpMax;
      const hpPct = Math.round((Math.max(0, hp) / hpMax) * 100);
      let flags = 0;
      if (rec.isConstructed) flags |= STRUCTURE_FLAG_BUILT;
      if (summary.powered) flags |= STRUCTURE_FLAG_POWERED;
      if (rec.isDeconstructing) flags |= STRUCTURE_FLAG_DECONSTRUCTING;
      // Every kind's flags (NOT inside the shield-emitter branch below — they
      // were, so these bits reached clients only for pylons and gates; locked
      // by structureFlagsWire.test.ts).
      if (rec.noAmmo === true) flags |= STRUCTURE_FLAG_NO_AMMO;
      if (rec.drawFull === true) flags |= STRUCTURE_FLAG_DRAW_FULL;
      if (h.breakIns.breached(rec.id)) flags |= STRUCTURE_FLAG_BREACH;
      if (rec.isConstructed && getStructureKind(rec.kind).fuelEveryPulses != null && rec.fueled !== true) flags |= STRUCTURE_FLAG_NO_FUEL;
      let wallTo = -1;
      if (isShieldEmitterKind(rec.kind)) {
        // Clients derive every wall from connections + this flag (all of this
        // emitter's walls are up). `shieldWallTo` stays for a pylon's first wall.
        if (h.shieldWalls().wallsUpFor(rec.id, nowMs)) flags |= STRUCTURE_FLAG_WALL_ACTIVE;
        if (rec.kind === 'shield_pylon') {
          const wall = h.shieldWalls().wallStateFor(rec.id, nowMs);
          const other = wall ? h.swarmRegistry.get(wall.otherPost)?.entityId : undefined;
          if (other !== undefined) wallTo = other;
        }
      }
      const building = !rec.isConstructed && rec.constructionCost > 0;
      const buildPct = building ? rec.constructionProgress / rec.constructionCost : 0;
      let etaMs = STRUCTURE_ETA_NONE;
      if (building) {
        const eta = h.structureGrid().estimateBuildEtaMs(rec);
        etaMs = eta === null ? STRUCTURE_ETA_STALLED : Math.max(0, Math.round(eta));
      }
      const deconstructPct = rec.isDeconstructing && rec.constructionCost > 0
        ? 1 - rec.constructionProgress / rec.constructionCost
        : 0;
      const storageMax = getStructureKind(rec.kind).powerStorageCapacity ?? 0;
      const ownerIdx = h.internStructureOwner(rec.owner);
      // Assign only on change — Colyseus patches exactly what changed.
      // (Unset fields read as STRUCTURE_DEFAULTS and are never encoded.)
      if ((st.ownerIdx ?? SD.ownerIdx) !== ownerIdx) st.ownerIdx = ownerIdx;
      if ((st.flags ?? SD.flags) !== flags) st.flags = flags;
      if ((st.hpPct ?? SD.hpPct) !== hpPct) st.hpPct = hpPct;
      if ((st.level ?? SD.level) !== rec.level) st.level = rec.level;
      const net = Math.fround(summary.netPower);
      if ((st.netPower ?? SD.netPower) !== net) st.netPower = net;
      if ((st.minerals ?? SD.minerals) !== rec.minerals) st.minerals = rec.minerals;
      const bp = Math.fround(buildPct);
      if ((st.buildPct ?? SD.buildPct) !== bp) st.buildPct = bp;
      if ((st.etaMs ?? SD.etaMs) !== etaMs) st.etaMs = etaMs;
      const dp = Math.fround(deconstructPct);
      if ((st.deconstructPct ?? SD.deconstructPct) !== dp) st.deconstructPct = dp;
      const stored = storageMax > 0 ? Math.round(rec.storedPower) : 0;
      if ((st.storedPower ?? SD.storedPower) !== stored) st.storedPower = stored;
      if ((st.storedPowerMax ?? SD.storedPowerMax) !== storageMax) st.storedPowerMax = storageMax;
      if ((st.shieldWallTo ?? SD.shieldWallTo) !== wallTo) st.shieldWallTo = wallTo;
      if (gateTypeOf(rec.kind) !== null) {
        const open = h.gates().maskFor(rec.id);
        if ((st.gateOpen ?? SD.gateOpen) !== open) st.gateOpen = open;
        const access = rec.gateAccess ?? SD.gateAccess;
        if ((st.gateAccess ?? SD.gateAccess) !== access) st.gateAccess = access;
      }
      if (isProcessorKind(rec.kind)) {
        // P2b — production status (recipe, state, missing input) for the inspector.
        const recipe = encodeRecipe(rec.recipe);
        if ((st.recipe ?? SD.recipe) !== recipe) st.recipe = recipe;
        const ps = rec.prodState ?? SD.prodState;
        if ((st.prodState ?? SD.prodState) !== ps) st.prodState = ps;
        const pm = ps === PROD_STATE.starved ? encodeGood(rec.prodMissing) : 0;
        if ((st.prodMissing ?? SD.prodMissing) !== pm) st.prodMissing = pm;
        const runs = encodeBpRuns(rec.blueprint);
        if ((st.bpRuns ?? SD.bpRuns) !== runs) st.bpRuns = runs;
        const bq = rec.blueprint !== undefined ? blueprintQuality(rec.blueprint) : 0;
        if ((st.bpQuality ?? SD.bpQuality) !== bq) st.bpQuality = bq;
      }
      if (isTeleporterKind(rec.kind)) this.syncTeleporterState(rec, st);
      this.syncConnTo(rec.id, st);
      // Fast cosmetics stay on the snapshot (only structures with a target).
      if (
        rec.turretTargetEntityId !== undefined ||
        rec.miningTargetEntityId !== undefined ||
        rec.turretTargetPlayer !== undefined
      ) {
        // TODO: alloc-debt — one small array per rebuild while any turret or
        // miner has a target (bounded by their count); A3 may pool it.
        targets ??= [];
        targets.push(
          entityId,
          rec.turretTargetPlayer !== undefined
            ? encodePlayerTurretTarget(h.internStructureOwner(rec.turretTargetPlayer))
            : (rec.turretTargetEntityId ?? STRUCTURE_TARGET_NONE),
          rec.miningTargetEntityId ?? STRUCTURE_TARGET_NONE,
        );
      }
    }
    // Sweep rows whose structure is gone (generation stamp — no Set alloc).
    for (const [key, g] of this.structureStateGen) {
      if (g === gen) continue;
      this.structureStateGen.delete(key);
      map.delete(key);
    }
    return targets;
  }

  /** v4 T1 — a teleporter's room-state fields (A2: assign only on change). */
  private syncTeleporterState(rec: StructureRecord, st: StructureState): void {
    const h = this.h;
    const phase = rec.tpPhase ?? 0;
    if ((st.tpPhase ?? SD.tpPhase) !== phase) {
      st.tpPhase = phase;
      // The phase's length rides along only when the phase changes (the client
      // times the animation from when the change arrives).
      const ms = phase === 0 ? 0 : Math.max(0, Math.min(65535, Math.round((rec.tpPhaseEndsAtMs ?? 0) - h.gameClock.now())));
      if ((st.tpPhaseMs ?? SD.tpPhaseMs) !== ms) st.tpPhaseMs = ms;
    }
    const req = h.teleporters().required(rec);
    const pct = req > 0 ? Math.min(100, Math.floor(((rec.tpCharge ?? 0) / req) * 100)) : 0;
    if ((st.tpChargePct ?? SD.tpChargePct) !== pct) st.tpChargePct = pct;
    const p = h.teleporters().partnerOf(rec);
    const partner = p !== null ? (h.swarmRegistry.get(p.id)?.entityId ?? -1) : rec.tpPartner !== undefined ? TP_PARTNER_REMOTE : -1;
    if ((st.tpPartner ?? SD.tpPartner) !== partner) st.tpPartner = partner;
    const r = rec.tpRules;
    const bits = r === undefined ? 0
      : (r.whenCharged ? TP_RULE_CHARGED : 0) | (r.shipBoards ? TP_RULE_BOARDS : 0) | (r.loaded ? TP_RULE_LOADED : 0) | (r.keepLoaded ? TP_RULE_KEEP : 0);
    const tollBits = rec.tpToll?.nonPayer === 'hostile' ? TP_RULE_TOLL_HOSTILE : 0;
    const tollPer = rec.tpToll?.per1000 ?? 0;
    if ((st.tpToll ?? SD.tpToll) !== tollPer) st.tpToll = tollPer;
    if ((st.tpRules ?? SD.tpRules) !== (bits | tollBits)) st.tpRules = bits | tollBits;
    const lg = r?.loaded ? (r.loaded.good === null ? 0 : encodeGood(r.loaded.good)) : 0;
    if ((st.tpLoadGood ?? SD.tpLoadGood) !== lg) st.tpLoadGood = lg;
    const lq = r?.loaded?.qty ?? 0;
    if ((st.tpLoadQty ?? SD.tpLoadQty) !== lq) st.tpLoadQty = lq;
    const kg = r?.keepLoaded ? encodeGood(r.keepLoaded.good) : 0;
    if ((st.tpKeepGood ?? SD.tpKeepGood) !== kg) st.tpKeepGood = kg;
    const kq = r?.keepLoaded?.qty ?? 0;
    if ((st.tpKeepQty ?? SD.tpKeepQty) !== kq) st.tpKeepQty = kq;
    const w = rec.padHold ? Math.min(65535, Math.round(holdWeight(rec.padHold))) : 0;
    if ((st.padWeight ?? SD.padWeight) !== w) st.padWeight = w;
  }

  /** Mirror a structure's connections into its room-state `connTo` only when
   *  the set changed (compared in place — no allocation when unchanged). */
  private syncConnTo(id: string, st: StructureState): void {
    const h = this.h;
    const conns = h.structureRegistry.connectionsOf(id);
    let n = 0;
    let same = true;
    for (const c of conns) {
      const other = c.getOtherNode(id);
      if (other === null) continue;
      const eid = h.swarmRegistry.get(other)?.entityId;
      if (eid === undefined) continue;
      if (n >= st.connTo.length || st.connTo.at(n) !== eid) same = false;
      n++;
    }
    if (same && n === st.connTo.length) return;
    st.connTo.clear();
    for (const c of conns) {
      const other = c.getOtherNode(id);
      if (other === null) continue;
      const eid = h.swarmRegistry.get(other)?.entityId;
      if (eid !== undefined) st.connTo.push(eid);
    }
  }
}
