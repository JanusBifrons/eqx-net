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
 *
 * God-file split slice 31 moved the two structure cadences here too: the 1 Hz
 * grid pulse (`gridTick`) and the 10 Hz turret tick (`turretTick`, with the
 * defence-turret mount-angles slice). Both end in the slice rebuild above; the
 * room's timers and seeders call them through one-line delegates
 * (`SectorRoom.structureGridTick` / `structureTurretTick`).
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
  STRUCTURE_FLAG_OFF,
  encodeStructureThrottleFlags,
  STRUCTURE_FLAG_BREACH,
  STRUCTURE_FLAG_LOCK_HOLDING,
  STRUCTURE_FLAG_GHOST_BODY,
  STRUCTURE_FLAG_MIRROR,
  STRUCTURE_TARGET_NONE,
  STRUCTURE_DEFAULTS as SD,
  encodePlayerTurretTarget,
  encodeStructureMountAngles,
} from '../../shared-types/structureStateWire.js';
import { isTeleporterKind } from '../../shared-types/teleport.js';
import { writeConnToRow, writeStorageFillRow, writeTeleporterRow } from '../structures/structureStateRows.js';
import { writeRigClipRow } from '../structures/structureRigClip.js';
import { writeDoorMotionRow, type GateDoorSource } from './doorMotionRow.js';
import { TERRITORY_LOCK_KIND, isHoldingTerritoryLock } from '../structures/territoryLockRules.js';
import { isShieldEmitterKind, gateTypeOf } from '../../core/structures/gateGeometry.js';
import { PROD_STATE, encodeBpRuns, encodeGood, encodeProdBay, encodeProdCount, encodeProdFrac, encodeRecipe, isProcessorKind } from '../../shared-types/production.js';
import { shipyardBayOf } from '../../core/articulation/rigs/heavyIndustry.js';
import { blueprintQuality } from '../../shared-types/blueprints.js';
import { isStructureBodySolid } from '../../core/structures/structureBody.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { effectiveStructureMaxHealth } from '../../core/leveling/structureLevel.js';
import type { GameClock } from '../../core/clock/GameClock.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { StructureRecord, StructureRegistry } from '../structures/StructureRegistry.js';
import type { StructureGridSubsystem } from '../structures/StructureGridSubsystem.js';
import type { ShieldWallManager } from '../structures/ShieldWallManager.js';
import type { GateController } from '../structures/GateController.js';
import type { TeleporterSubsystem } from '../structures/TeleporterSubsystem.js';
import type { BreakInSubsystem } from './BreakInSubsystem.js';
import type { GridFlowMaterial, GridPulseEvent, SnapshotMessage } from '../../shared-types/messages.js';
import type { HostileActLedger } from '../../core/relations/HostileActLedger.js';
import type { RelationContext } from '../../shared-types/relations.js';
import type { PatrolSubsystem } from '../bases/PatrolSubsystem.js';
import type { AlienGateGuard } from '../structures/AlienGateGuard.js';
import type { ProductionSubsystem } from '../structures/ProductionSubsystem.js';
import type { ResearchLabSubsystem } from '../structures/ResearchLabSubsystem.js';
import type { StorageService } from '../cargo/StorageService.js';
import type { MineFieldSubsystem } from '../structures/MineFieldSubsystem.js';
import type { TurretTargeting } from './features/turretTargeting.js';

/** What the sync reads from the room. Getters for fields the room assigns
 *  in `onCreate` (or reads through a getter of its own). */
export interface StructuresSliceHost {
  state: () => SectorState;
  gameClock: Pick<GameClock, 'now'>;
  structureRegistry: Pick<StructureRegistry, 'all' | 'connectionsOf' | 'size'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'get'>;
  swarmHealth: () => Map<string, number>;
  breakIns: Pick<BreakInSubsystem, 'breached' | 'tick'>;
  structureGrid: () => Pick<
    StructureGridSubsystem,
    'powerSummaryFor' | 'estimateBuildEtaMs' | 'pulse' | 'tickTurrets' | 'tickMiners' | 'mountAnglesOf'
  >;
  shieldWalls: () => Pick<ShieldWallManager, 'wallsUpFor' | 'wallStateFor' | 'update'>;
  /** `maskFor` and the door states (`GateDoorSource`) for the door rows. */
  gates: () => Pick<GateController, 'maskFor' | 'update'> & GateDoorSource;
  teleporters: () => Pick<TeleporterSubsystem, 'required' | 'partnerOf' | 'pulse' | 'update'>;
  /** The room's owner interning (also used by the mine sync). */
  internStructureOwner: (owner: string) => number;
  /** Who holds this sector now (`sectorHeldBy`; null = neutral). Read only
   *  when the room has a Territory Lock, once per sync. */
  sectorHeldBy: () => string | null;
  // ── The grid pulse / turret tick cadences (slice 31) ──
  hostileActs: () => Pick<HostileActLedger, 'sweep'>;
  patrols: Pick<PatrolSubsystem, 'count' | 'tick'>;
  gateGuard: Pick<AlienGateGuard, 'sweep'>;
  production: () => Pick<ProductionSubsystem, 'pulse' | 'cycleFraction'>;
  researchLabs: () => Pick<ResearchLabSubsystem, 'pulse'>;
  storage: () => Pick<StorageService, 'flushDirty'>;
  mineField: () => Pick<MineFieldSubsystem, 'mines' | 'tick'>;
  turretTargeting: () => Pick<TurretTargeting, 'turretTargetGridFresh' | 'npcTargetGridFresh'>;
  relationCtx: () => RelationContext;
  testTeleportFullCharge: () => boolean;
  /** The room's `rebuildStructuresSlice` (stores the targets slice it returns). */
  rebuildStructuresSlice: () => void;
  broadcastGridPulse: (msg: GridPulseEvent) => void;
}

export class StructuresSliceSync {
  /** A2 — entityId key → generation last synced (stale-row sweep, alloc-free). */
  private readonly structureStateGen = new Map<string, number>();
  private structureStateGeneration = 0;

  /** Coastal defences — the defence turrets' angles, rebuilt each turret tick
   *  into one reused array (#14); undefined while every turret rests. */
  private readonly structureMountAnglesBuf: number[] = [];
  structureMountAnglesSlice: SnapshotMessage['structureMountAngles'] = undefined;

  constructor(private readonly h: StructuresSliceHost) {}

  /** Sync `state.structures` and return the snapshot's slim cosmetic slice
   *  (turret / mining targets only; undefined when nothing has a target). */
  rebuild(): number[] | undefined {
    const h = this.h;
    const map = h.state().structures;
    const gen = ++this.structureStateGeneration;
    let targets: number[] | undefined;
    const nowMs = h.gameClock.now();
    let held: string | null | undefined; // the sector's holder, read on the first lock
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
      if (!isStructureBodySolid(rec)) flags |= STRUCTURE_FLAG_GHOST_BODY; // hologram pass-through
      // Every kind's flags (NOT inside the shield-emitter branch below — they
      // were, so these bits reached clients only for pylons and gates; locked
      // by structureFlagsWire.test.ts).
      if (rec.noAmmo === true) flags |= STRUCTURE_FLAG_NO_AMMO;
      if (rec.drawFull === true) flags |= STRUCTURE_FLAG_DRAW_FULL;
      if (rec.switchedOff === true) flags |= STRUCTURE_FLAG_OFF;
      if (rec.mirror === true) flags |= STRUCTURE_FLAG_MIRROR;
      if (rec.throttle !== undefined) flags |= encodeStructureThrottleFlags(rec.throttle);
      if (h.breakIns.breached(rec.id)) flags |= STRUCTURE_FLAG_BREACH;
      if (rec.isConstructed && getStructureKind(rec.kind).fuelEveryPulses != null && rec.fueled !== true) flags |= STRUCTURE_FLAG_NO_FUEL;
      if (rec.kind === TERRITORY_LOCK_KIND && isHoldingTerritoryLock(rec, held === undefined ? (held = h.sectorHeldBy()) : held)) {
        flags |= STRUCTURE_FLAG_LOCK_HOLDING;
      }
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
      const gateType = gateTypeOf(rec.kind);
      if (gateType !== null) {
        // Door slice 9: the door segment rides gateOpen + the rig fields.
        writeDoorMotionRow(rec.id, gateType, h.gates(), st);
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
        const bq = runs !== 0 ? blueprintQuality(rec.blueprint!) : 0;
        if ((st.bpQuality ?? SD.bpQuality) !== bq) st.bpQuality = bq;
        const pc = encodeProdCount(rec.prodCount); // job 2E — outputs left
        if ((st.prodCount ?? SD.prodCount) !== pc) st.prodCount = pc;
        const pf = encodeProdFrac(h.production().cycleFraction(rec)); // loop 3L (#16)
        if ((st.prodFrac ?? SD.prodFrac) !== pf) st.prodFrac = pf;
        // Loop 3R (#16): the bay this build is in; no build queue on this base yet.
        const pb = rec.kind === 'shipyard' ? encodeProdBay(shipyardBayOf(rec.prodCycles), 0) : 0;
        if ((st.prodBay ?? SD.prodBay) !== pb) st.prodBay = pb;
      }
      if (isTeleporterKind(rec.kind)) this.syncTeleporterState(rec, st);
      writeStorageFillRow(rec, st); // storage fill gauge, on step change only
      // restyle 2e (late-join safe, #16); door kinds' rig fields are the door row's.
      if (rec.rigClip !== undefined && gateType === null) writeRigClipRow(rec, st);
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

  /** Structure id → its swarm entity id (one bound closure: the row writers
   *  run per structure per rebuild and allocate nothing). */
  private readonly entityIdOf = (id: string): number | undefined => this.h.swarmRegistry.get(id)?.entityId;

  /** v4 T1 — a teleporter's room-state fields (`writeTeleporterRow`). */
  private syncTeleporterState(rec: StructureRecord, st: StructureState): void {
    writeTeleporterRow(rec, st, this.h.gameClock.now(), this.h.teleporters(), this.entityIdOf);
  }

  /** `writeConnToRow`: the structure's connections into `connTo`, on change. */
  private syncConnTo(id: string, st: StructureState): void {
    writeConnToRow(id, st, this.h.structureRegistry, this.entityIdOf);
  }

  // ── Structure grid pulse (structures plan, Phase 3) ──────────────────────

  /** One 1 Hz grid heartbeat: pulse the logistics web, refresh the snapshot
   *  slice, and broadcast the discrete `grid_pulse` flash event. No-op (and no
   *  broadcast) when the sector has no structures. */
  gridTick(): void {
    const h = this.h;
    h.hostileActs().sweep(h.gameClock.now());
    if (h.patrols.count > 0) h.patrols.tick(h.gameClock.now());
    h.gateGuard.sweep(h.gameClock.now());
    if (h.structureRegistry.size === 0) return;
    const result = h.structureGrid().pulse(h.gameClock.now());
    // P2b — processors take inputs from and put outputs into network storage.
    h.production().pulse();
    // v4 T1 — teleporter pads unload arrivals and top up "keep loaded".
    h.teleporters().pulse();
    // Economy v2 W3 — powered Research Labs advance their jobs.
    h.researchLabs().pulse();
    // Living World P1a-2 — persist storage payloads the pulse just changed
    // (mining / hauling / construction flows mutate the bank directly).
    h.storage().flushDirty();
    // Form/teardown pylon-pair walls + refresh their active state on the fresh
    // topology BEFORE the slice rebuild so `shieldWallTo`/`wallActive` are current.
    h.shieldWalls().update(h.gameClock.now());
    h.rebuildStructuresSlice();
    if (result.flashed.length > 0) {
      // Map the registry's string-id pairs to dense entityIds for the wire,
      // carrying each edge's flow MATERIAL (WS-D #12) so the client tints
      // per-edge (repair/minerals/construction can co-occur in one pulse).
      const flashed: Array<[number, number, GridFlowMaterial]> = [];
      for (const [a, b, material] of result.flashed) {
        const ea = h.swarmRegistry.get(a)?.entityId;
        const eb = h.swarmRegistry.get(b)?.entityId;
        if (ea !== undefined && eb !== undefined) flashed.push([ea, eb, material]);
      }
      if (flashed.length > 0) {
        h.broadcastGridPulse({ type: 'grid_pulse', flashed, material: result.material });
      }
    }
  }

  /** Coastal defences — pack every defence turret that is off its rest
   *  bearing into the snapshot's `structureMountAngles` (the server's slewed
   *  angles, the only writer, #12). One reused array (#14). */
  private rebuildStructureMountAngles(): void {
    const h = this.h;
    const buf = this.structureMountAnglesBuf;
    let n = 0;
    for (const rec of h.structureRegistry.all()) {
      const angles = h.structureGrid().mountAnglesOf(rec.id);
      if (angles === undefined) continue;
      const entityId = h.swarmRegistry.get(rec.id)?.entityId;
      if (entityId === undefined) continue;
      n = encodeStructureMountAngles(buf, n, entityId, angles);
    }
    buf.length = n;
    this.structureMountAnglesSlice = n > 0 ? buf : undefined;
  }

  /** Phase 5 — turret aim/fire tick (faster cadence than the grid pulse).
   *  No-op when the sector has no structures. */
  turretTick(): void {
    const h = this.h;
    // C2/C3 — break-ins tick even in a sector with no structures (ship targets).
    h.breakIns.tick();
    if (h.structureRegistry.size === 0) {
      // Mines whose layer is gone still have to leave.
      if (h.mineField().mines.size > 0) h.mineField().tick(h.gameClock.now());
      return;
    }
    const nowMs = h.gameClock.now();
    // A1 — the turret target grid is rebuilt (lazily, on the first query) once
    // per turret tick, instead of every turret scanning every swarm entity.
    h.turretTargeting().turretTargetGridFresh = false;
    h.turretTargeting().npcTargetGridFresh = false;
    h.relationCtx().nowMs = nowMs;
    h.structureGrid().tickTurrets(nowMs);
    this.rebuildStructureMountAngles();
    // Mine Layers lay and mines go off (same target grids as the turrets).
    h.mineField().tick(nowMs);
    // v4 T1 — teleporter rules and jump cycles.
    if (h.testTeleportFullCharge()) {
      for (const r of h.structureRegistry.all()) {
        if (isTeleporterKind(r.kind) && r.tpPartner !== undefined) r.tpCharge = Math.max(r.tpCharge ?? 0, h.teleporters().required(r));
      }
    }
    h.teleporters().update(nowMs);
    // WS-4 — re-broadcast each Miner's mining beam on the same fast cadence so
    // the continuous beam tracks + doesn't flicker (gated per-Miner internally).
    h.structureGrid().tickMiners(nowMs);
    // Gates open/close on approach at this cadence, re-posing each gate's
    // door-leaf hit boxes (a shut leaf blocks shots).
    h.gates().update(nowMs);
    // Refresh wall active states at the turret cadence so a stun lifts (and a
    // power-loss drop registers) within ~100 ms, not a full grid pulse later.
    h.shieldWalls().update(h.gameClock.now());
    // Refresh the slice so the client's turret aim line tracks at the turret
    // cadence (not just the 1 Hz pulse). Cheap — few structures, off the tick.
    h.rebuildStructuresSlice();
  }
}
