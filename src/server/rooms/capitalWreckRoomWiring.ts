/**
 * The room side of the capital-wreck subsystem: the `CapitalWreckDeps` a
 * `SectorRoom` wires into `CapitalWreckSubsystem` (capital destruction S2a),
 * moved out of the room (god-file split slice 28). Boot-only: the room calls
 * `buildCapitalWrecks(host)` once, under its wreck switches, with a narrow
 * host built inline at that call site. Fields the room reassigns (or assigns
 * after boot, like the SAB views and the worker proxy) are `() => value`
 * getters, read lazily exactly as the room's own closures read `this.x`.
 * The closures allocate nothing beyond what they did in the room.
 */
import { CapitalWreckSubsystem, type WreckPiecePose } from './CapitalWreckSubsystem.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SectorState, ShipState } from './schema/SectorState.js';
import type { PatrolSubsystem } from '../bases/PatrolSubsystem.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import type { PhysicsWorkerProxy, WorkerCmd } from './PhysicsWorkerProxy.js';
import type { LootSubsystem } from '../cargo/LootSubsystem.js';
import type { LockSubsystem } from './LockSubsystem.js';
import type { BattleWreckSaves } from './wreckLineageSaves.js';
import type { WreckFieldSource } from './WreckFieldSource.js';
import type { CutFieldSubsystem } from './CutFieldSubsystem.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import { SWARM_KIND_DRONE, SWARM_KIND_STRUCTURE } from '../../shared-types/swarmWireFormat.js';
import type { RoomWreckSpawns } from './features/wreckSpawns.js';
import { FLAG_SLEEPING, SLOT_FLAGS_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase, slotPoseInto } from '../../shared-types/sabLayout.js';
import { rockViewOf } from './rockCut.js';
import { relayPieceSplit } from './lockSplit.js';

/** What the capital-wreck wiring reads from the room. */
export interface CapitalWreckRoomHost {
  serverTick: () => number;
  swarmRegistry: SwarmEntityRegistry;
  wreckKindAllowed: (kindId: string) => boolean;
  getActiveShip: (playerId: string) => ShipState | undefined;
  state: () => SectorState;
  patrols: PatrolSubsystem;
  shipPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  lingeringPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  sabF32: () => Float32Array;
  sabU32: () => Uint32Array;
  swarmSpawner: () => SwarmSpawner;
  physicsWorkerProxy: () => PhysicsWorkerProxy;
  evictSwarmEntity: (rec: SwarmEntityRecord, opts: { broadcast: boolean; emitDestroyed: boolean }) => void;
  wreckPose: (id: string, out?: WreckPiecePose) => WreckPiecePose | null;
  /** The room's reused pose scratch for `pieceAngle`. */
  wreckPoseScratch: WreckPiecePose;
  postToWorker: (cmd: WorkerCmd) => void;
  /** The room's reused `WRECK_IMPULSE` command (#14). */
  wreckImpulseCmd: Extract<WorkerCmd, { type: 'WRECK_IMPULSE' }>;
  /** The room's reused `WRECK_RIGID_IMPULSE` command (#14). */
  wreckRigidImpulseCmd: Extract<WorkerCmd, { type: 'WRECK_RIGID_IMPULSE' }>;
  playerToSlot: () => ReadonlyMap<string, number>;
  lingeringSlots: ReadonlyMap<string, number>;
  loot: () => LootSubsystem;
  locks: () => LockSubsystem;
  wingmanLocks: () => LockSubsystem;
  wreckSaves: () => BattleWreckSaves | null;
  wreckFieldSource: () => WreckFieldSource | undefined;
  /** The room's cut field (field rock cut 1C-b: its rocks are cut, woken and
   *  marked consumed through it); undefined: none. */
  cutField: () => Pick<CutFieldSubsystem, 'navOpts' | 'wakeRock' | 'markConsumed'> | undefined;
  /** Structure break-up T6: a structure's wreck source (null: it does not
   *  break here) and its registry owner (the pieces' livery). */
  structures: Pick<RoomWreckSpawns, 'structureWreckSourceOf' | 'structureOwnerOf'>;
}

/** Capital destruction S2a: build the wreck subsystem (flag on only). */
export function buildCapitalWrecks(h: CapitalWreckRoomHost): CapitalWreckSubsystem {
  return new CapitalWreckSubsystem({
    serverTick: () => h.serverTick(),
    wreckKindOf: (id) => {
      const rec = h.swarmRegistry.get(id);
      if (rec?.kind === SWARM_KIND_STRUCTURE) return h.structures.structureWreckSourceOf(id);
      if (rec) return rec.kind === SWARM_KIND_DRONE && rec.shipKind && h.wreckKindAllowed(rec.shipKind) ? (rec.shipKind as ShipKindId) : null;
      const ship = h.getActiveShip(id) ?? h.state().ships.get(id);
      return ship !== undefined && h.wreckKindAllowed(ship.kind) ? (ship.kind as ShipKindId) : null;
    },
    // The livery owner, as the client resolves it for the live hull: a
    // player hull (active by playerId, parked by shipInstanceId) its
    // pilot's id, a patrol its faction (snapshot `fac`), a structure its
    // registry owner, else none.
    ownerOf: (id) => {
      if (h.swarmRegistry.get(id)?.kind === SWARM_KIND_STRUCTURE) return h.structures.structureOwnerOf(id);
      if (h.swarmRegistry.has(id)) return h.patrols.count > 0 ? h.patrols.factionOf(id) : undefined;
      const ship = h.getActiveShip(id) ?? h.state().ships.get(id);
      return ship !== undefined && ship.playerId !== '' ? ship.playerId : undefined;
    },
    positionOf: (id) => {
      const p = h.shipPoseCache.get(id) ?? h.lingeringPoseCache.get(id);
      if (p) return { x: p.x, y: p.y };
      const rec = h.swarmRegistry.get(id);
      if (!rec) return null;
      const b = slotBase(rec.slot);
      const f32 = h.sabF32();
      return { x: f32[b + SLOT_X_OFF]!, y: f32[b + SLOT_Y_OFF]! };
    },
    spawnPiece: (spec) => (h.swarmRegistry.has(spec.id) ? false : h.swarmSpawner().spawnWreck(spec)),
    beginBatch: () => h.physicsWorkerProxy().beginBatch(),
    endBatch: () => h.physicsWorkerProxy().endBatch(),
    removePiece: (id) => {
      const rec = h.swarmRegistry.get(id);
      if (rec) h.evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false });
    },
    isLive: (id) => h.swarmRegistry.has(id),
    pieceAngle: (id) => h.wreckPose(id, h.wreckPoseScratch)?.angle ?? null,
    kickPiece: (id, dvx, dvy, dw) => h.postToWorker({ type: 'WRECK_KICK', entityId: id, dvx, dvy, dw }),
    // A reused command (#14): postMessage clones it synchronously.
    impulsePiece: (id, jx, jy, px, py) => {
      const c = h.wreckImpulseCmd;
      c.entityId = id; c.jx = jx; c.jy = jy; c.px = px; c.py = py;
      h.postToWorker(c);
    },
    // A piece's body sits on its centroid: its SAB pose is the centre (#14).
    pieceCentreInto: (id, out) => h.wreckPose(id, out) !== null,
    // During the crack hold: the whole wreck as one rigid body (#14 as above).
    impulseWreck: (ids, jx, jy, px, py) => {
      const c = h.wreckRigidImpulseCmd;
      c.entityIds = ids; c.jx = jx; c.jy = jy; c.px = px; c.py = py;
      h.postToWorker(c);
    },
    pieceAsleep: (id) => {
      const rec = h.swarmRegistry.get(id);
      return rec != null && ((h.sabU32()[slotBase(rec.slot) + SLOT_FLAGS_OFF] ?? 0) & FLAG_SLEEPING) !== 0;
    },
    piecePose: (id) => h.wreckPose(id),
    piecePoseInto: (id, out) => h.wreckPose(id, out) !== null,
    // Fracture v12 multi-cut: a live hull's SAB pose at a cutting hit (a
    // drone by its record, an active hull by playerId, a parked one by
    // shipInstanceId), the frame its burn line is kept in. #14: into `out`.
    hullPoseInto: (id, out) => {
      const slot = h.swarmRegistry.get(id)?.slot ?? h.playerToSlot().get(id) ?? h.lingeringSlots.get(id);
      if (slot !== undefined) slotPoseInto(h.sabF32(), slot, out);
      return slot !== undefined;
    },
    dropSalvage: (qty, x, y, vx, vy) => h.loot().drop({ goods: { salvage: qty }, blueprints: [] }, x, y, vx, vy, { cause: 'salvage' }),
    rockOf: (id) => rockViewOf(h.swarmRegistry, id, h.cutField()?.navOpts ?? null),
    wakeFieldRock: (id, by) => { h.cutField()?.wakeRock(id, by, h.serverTick()); },
    fieldRockBroken: (key) => h.cutField()?.markConsumed(key),
    pieceSplit: (from, ids, masses) => relayPieceSplit(h.swarmRegistry, from, ids, masses, h.locks(), h.wingmanLocks()),
    lineageTouched: (root) => { h.wreckSaves()?.touch(root); h.wreckFieldSource()?.touched(root); }, evictRetire: (id) => h.wreckSaves()?.evictPiece(id) ?? false,
  });
}
