/**
 * The room's wreck spawns (capital destruction S2a, sub-capital break-up,
 * wreck fields 3b): which kinds break into wreck pieces here, a dying hull's
 * break-up (`spawnCapitalWreck`, `spawnActiveHullWreck` and its
 * `vaporisedActiveDeath` note), a live piece's SAB pose, and the boot-time
 * wreck-field chunk source. Moved verbatim out of `SectorRoom` (god-file
 * split slice 54); the room hands in live accessors.
 *
 * Structure break-up T6: a destroyed structure breaks through the same
 * `CapitalWreckSubsystem.onDeath` (`spawnStructureWreck`), behind its own
 * switch (`structureWrecksOn`, read once at boot by `readStructureSwitch`).
 *
 * The wreck subsystem itself (`CapitalWreckSubsystem`, built by
 * `capitalWreckRoomWiring.ts`) and the room's wreck switches stay the room's;
 * they are read here through getters, as the room's own methods read them.
 */
import type { Logger } from 'pino';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { ShipState } from '../schema/SectorState.js';
import type { CapitalWreckSubsystem, WreckPiecePose } from '../CapitalWreckSubsystem.js';
import type { ForceFieldSubsystem } from '../ForceFieldSubsystem.js';
import type { WorkerCmd } from '../PhysicsWorkerProxy.js';
import type { FieldClearing } from '../../../core/terrain/fieldLayout.js';
import { WreckFieldSource, type WreckFieldRoomOpts } from '../WreckFieldSource.js';
import { cutFieldOpts } from '../../../core/terrain/chunkStreamer.js';
import { rockFieldBlocker, wreckField } from '../../../core/terrain/wreckFieldLayout.js';
import { wreckKindAllowed } from '../../../core/destruction/wreckKindAllowed.js';
import { terrainRecordStoreFor } from '../../db/PersistenceWorker.js';
import { getShipKind, type ShipKindId } from '../../../shared-types/shipKinds.js';
import { FLAG_SLEEPING, SLOT_FLAGS_OFF, slotBase, slotPoseInto } from '../../../shared-types/sabLayout.js';
import type { StructureRecord } from '../../structures/StructureRegistry.js';
import type { SwarmEntityRecord } from '../../net/SwarmEntityRegistry.js';
import { structureBreaks, structureWreckSource, type WreckSource } from '../../../core/destruction/wreckSource.js';
import { effectiveStructureMaxHealth } from '../../../core/leveling/structureLevel.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { SWARM_KIND_STRUCTURE } from '../../../shared-types/swarmWireFormat.js';
import { structureWreckSwitchOn } from '../wreckSwitch.js';

/** What the wreck spawns read from the room. Getters for fields the room
 *  assigns in `onCreate` (the subsystem, the switches, the SAB views, the
 *  sector key) or reassigns. */
export interface RoomWreckSpawnsHost {
  logger: Pick<Logger, 'info' | 'warn'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'get'>;
  forceFields: Pick<ForceFieldSubsystem, 'isTractored'>;
  shipPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  capitalWrecks: () => CapitalWreckSubsystem | null;
  capitalWrecksOn: () => boolean;
  subcapWrecksOn: () => boolean;
  persistSector: () => boolean;
  sectorKey: () => string | null;
  sabF32: () => Float32Array;
  sabU32: () => Uint32Array;
  playerToSlot: () => ReadonlyMap<string, number>;
  getActiveShip: (playerId: string) => ShipState | undefined;
  postToWorker: (cmd: WorkerCmd) => void;
  /** The structure registry (kind, built state, owner, level of a structure). */
  structureRegistry: { get(id: string): StructureRecord | undefined };
}

export class RoomWreckSpawns {
  /** The playerId whose ACTIVE hull was just vaporised, for its pod's
   *  vaporised salvage; read and cleared by the `SHIP_DESTROYED` handler. */
  vaporisedActiveDeath: string | null = null;
  /** Structure break-up switch (`structureWreckSwitchOn`); off by default. */
  structureWrecksOn = false;

  constructor(private readonly h: RoomWreckSpawnsHost) {}

  /** Wreck fields 3b: the room option `wreckField` as a chunk source of the
   *  ONE streamer (`WreckFieldSource`; macro-terrain.md F3), laid out once
   *  at boot around the cut field's rocks and clearings, under the room's
   *  wreck switches. The room keeps the returned source as `wreckFieldSource`. */
  buildWreckFieldSource(o: WreckFieldRoomOpts, cut: { seed: string; clearings?: FieldClearing[] } | undefined): WreckFieldSource {
    const h = this.h;
    const field = wreckField({
      ...o, capitalWrecksOn: h.capitalWrecksOn(), subcapWrecksOn: h.subcapWrecksOn(),
      ...(!o.clearings && cut?.clearings ? { clearings: cut.clearings } : {}),
      ...(cut ? { blocked: rockFieldBlocker(cutFieldOpts(cut.seed, cut.clearings)) } : {}),
    });
    h.logger.info({ seed: o.seed, hulls: field.hulls.length, dropped: field.dropped }, 'wreck field laid out');
    const sectorKey = h.sectorKey();
    return new WreckFieldSource(field, {
      wrecks: () => h.capitalWrecks() ?? undefined,
      piecePoseInto: (id, out) => this.wreckPose(id, out) !== null,
      pieceAwake: (id) => {
        const rec = h.swarmRegistry.get(id);
        return rec != null && ((h.sabU32()[slotBase(rec.slot) + SLOT_FLAGS_OFF] ?? 0) & FLAG_SLEEPING) === 0;
      },
      tractored: (id) => h.forceFields.isTractored(id),
      ...(o.fresh === true ? { fresh: true } : {}), // dev look flag (wreck fields 9)
      warn: (obj, msg) => h.logger.warn(obj, msg), ...(h.persistSector() && sectorKey !== null ? { records: terrainRecordStoreFor(`${sectorKey}|wrecks:${o.seed}`) } : {}), // slice 4: touched hulls' rows
    });
  }

  /** Boot: read the structure break-up switch (room option `structureWrecks`,
   *  env `EQX_STRUCTURE_WRECKS` wins). */
  readStructureSwitch(roomOpt: boolean | undefined): void {
    this.structureWrecksOn = structureWreckSwitchOn(process.env['EQX_STRUCTURE_WRECKS'], roomOpt);
  }

  /** The wreck source of a structure that breaks here (switch on, a built
   *  kind with the `structure` profile; `structureBreaks`), else null. Read
   *  per hit by `wreckKindOf` (a memoised source: no allocation, #14). */
  structureWreckSourceOf(id: string): WreckSource | null {
    if (!this.structureWrecksOn || this.h.capitalWrecks() === null) return null;
    const s = this.h.structureRegistry.get(id);
    return s !== undefined && structureBreaks(s.kind, s.isConstructed) ? structureWreckSource({ k: s.kind }) : null;
  }

  /** A structure's registry owner (its wreck keeps the livery; T5 reads
   *  `desc.owner`), or undefined when it is not a structure. */
  structureOwnerOf(id: string): string | undefined {
    const o = this.h.structureRegistry.get(id)?.owner;
    return o !== undefined && o !== '' ? o : undefined;
  }

  /** Structure break-up T6: a dying structure (kind 2) breaks into wreck
   *  pieces through the ship death path (`CapitalWreckSubsystem.onDeath`),
   *  its body despawned before the pieces spawn. The SAB pose is still live
   *  (called before `evictSwarmEntity`). Max hull is the structure's
   *  effective one (level, packed quality). True = vaporised. */
  spawnStructureWreck(rec: SwarmEntityRecord): boolean {
    const capitalWrecks = this.h.capitalWrecks();
    const src = rec.kind === SWARM_KIND_STRUCTURE ? this.structureWreckSourceOf(rec.id) : null;
    const s = this.h.structureRegistry.get(rec.id);
    if (capitalWrecks === null || src === null || s === undefined) return false;
    const pose = slotPoseInto(this.h.sabF32(), rec.slot, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });
    const maxHull = effectiveStructureMaxHealth(getStructureKind(s.kind).maxHealth, s.level, s.packedQuality);
    const slot = rec.slot, id = rec.id;
    return capitalWrecks.onDeath(id, src, pose, maxHull > 0 ? maxHull : src.maxHull,
      () => this.h.postToWorker({ type: 'DESPAWN', slot, playerId: id })).vaporised;
  }

  /** A live wreck piece's SAB pose into `out` (#14 with a reused `out`), or null when gone. */
  wreckPose(id: string, out: WreckPiecePose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }): WreckPiecePose | null {
    const rec = this.h.swarmRegistry.get(id);
    return rec ? slotPoseInto(this.h.sabF32(), rec.slot, out) : null;
  }

  /** Does a ship of `kindId` break into wreck pieces in this room? Read from
   *  its destruction profile (#18): `capital` with `capitalWrecks`; `subcap`
   *  with `subcapWrecks`, except composite kinds (havok), which keep their
   *  per-component scrap; `none` never. */
  wreckKindAllowed(kindId: string): boolean {
    return wreckKindAllowed(kindId, this.h.capitalWrecksOn(), this.h.subcapWrecksOn());
  }

  /** S2a: a dying ACTIVE hull breaks into wreck bodies, its worker body
   *  despawned (the slot stays for respawn / pilot swap). Called by its death
   *  policy BEFORE the `destroy` broadcast; true = vaporised (fracture v11).
   *  A vaporised death is noted for the `SHIP_DESTROYED` handler's pod
   *  (`vaporisedActiveDeath`: emitted right after, same call stack). */
  spawnActiveHullWreck(playerId: string): boolean {
    this.vaporisedActiveDeath = null;
    const activeHull = this.h.getActiveShip(playerId);
    const slot = this.h.playerToSlot().get(playerId);
    if (activeHull === undefined || slot === undefined || activeHull.alive !== false || this.h.capitalWrecks() === null || !this.wreckKindAllowed(activeHull.kind)) return false;
    // The pose every hit test this tick used (`shipPoseCache`), so a kill
    // cut lands where the killing shot hit (the burned gap stays on the
    // beam's line even when the worker stepped on since); the SAB otherwise.
    const pose = this.h.shipPoseCache.get(playerId) ?? slotPoseInto(this.h.sabF32(), slot, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });
    const vaporised = this.spawnCapitalWreck(playerId, activeHull.kind, pose,
      activeHull.maxHealth > 0 ? activeHull.maxHealth : getShipKind(activeHull.kind).maxHealth, slot, playerId);
    if (vaporised) this.vaporisedActiveDeath = playerId;
    return vaporised;
  }

  /** S2a: a dying capital (any liveness class) breaks into wreck bodies.
   *  `targetId` is the id its hits were tracked under. True when a cut kill
   *  vaporised it (fracture v11). Call while the dying body is live; `bodySlot` / `bodyId` name its worker body, which
   *  is despawned BEFORE the pieces spawn (the worker may step between two
   *  commands, so a later despawn left the pieces overlapping the hull for
   *  a step; `CapitalWreckSubsystem.onDeath`). The caller's own despawn
   *  after this is then a no-op for the body. */
  spawnCapitalWreck(
    targetId: string, kindId: string,
    pose: { x: number; y: number; vx: number; vy: number; angle: number; angvel?: number },
    maxHull: number,
    bodySlot?: number, bodyId?: string,
  ): boolean {
    const capitalWrecks = this.h.capitalWrecks();
    if (capitalWrecks === null || !this.wreckKindAllowed(kindId)) return false;
    const despawn = bodySlot !== undefined && bodyId !== undefined
      ? () => this.h.postToWorker({ type: 'DESPAWN', slot: bodySlot, playerId: bodyId })
      : undefined;
    return capitalWrecks.onDeath(targetId, kindId as ShipKindId,
      { x: pose.x, y: pose.y, vx: pose.vx, vy: pose.vy, angle: pose.angle, angvel: pose.angvel ?? 0 }, maxHull, despawn).vaporised;
  }
}
