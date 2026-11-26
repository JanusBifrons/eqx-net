/**
 * Teleporter client messages — pair, unpair, fire, rules, tolls, pad
 * load/unload and cross-sector pair requests (v4 T1-T4), plus the pad riders
 * (`TeleportPadRiders`: who rides a jump and how they move) and the build of the
 * room's `TeleporterSubsystem` + broker `TeleportRoom` (`buildTeleporters`).
 * Moved verbatim out of `SectorRoom.onCreate`; the room hands in live accessors so every handler
 * reads the same state it did when it lived there.
 */
import type { Client } from 'colyseus';
import { randomUUID } from 'node:crypto';
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import { TeleporterSubsystem, findAlienTwin, findLinkTwin, type GateTwinHost, type PartnerLink } from '../../structures/TeleporterSubsystem.js';
import { GATE_SPAN_THICKNESS } from '../../../core/structures/gateGeometry.js';
import type { ForceFieldSubsystem } from '../ForceFieldSubsystem.js';
import type { TeleportTolls } from './teleportTolls.js';
import { getTeleportBroker, type RiderBatch, type TeleportRoom } from '../../teleport/TeleportBroker.js';
import type { MapSchema } from '@colyseus/schema';
import type { ShipState } from '../schema/SectorState.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { TransitOrchestrator } from '../../transit/TransitOrchestrator.js';
import type { FleetCommandSubsystem } from '../../fleet/FleetCommandSubsystem.js';
import type { WorkerCmd } from '../PhysicsWorkerProxy.js';
import type { HullMove } from './transitMessages.js';
import { JOIN_BROADCAST_GRACE_TICKS } from '../join/joinConstants.js';
import { hopDistance } from '../../livingworld/population.js';
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { slotBase, TICK_IDX, SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_ANGVEL_OFF } from '../../../shared-types/sabLayout.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import { parsedMessage, type ParsedMessageHost, type MessageSchema, type RoomFeature } from './parsedMessage.js';
import type { StorageService } from '../../cargo/StorageService.js';
import { padAngle, type PadDoors } from '../../structures/padDoors.js';
import { getSector } from '../../../core/galaxy/galaxy.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { isNpcOwner, relationOf, type RelationContext } from '../../../shared-types/relations.js';
import {
  isAlienGateKind,
  isFreeTeleporterKind,
  isPadChamberKind,
  isRoundPadKind,
  isTeleporterKind,
  onPad,
  padIrisSpanCount,
  padIrisSpanLocal,
  padPushHalf,
  PAD_SPECS,
  SetTeleportRulesSchema,
  SetTeleportTollSchema,
  TeleportCandidatesQuerySchema,
  TeleportFireSchema,
  TeleportPadLoadSchema,
  TeleportPadUnloadSchema,
  TeleportPairAnswerSchema,
  TeleportPairRemoteSchema,
  TeleportPairRequestSchema,
  TeleportPairSchema,
  TeleportUnpairSchema,
  TollAnswerSchema,
  TP_PHASE,
  type PairRequestPrompt,
  type TeleporterKind,
  type TollAnswer,
} from '../../../shared-types/teleport.js';

/** What the handlers need from the room; getters read the live field. */
export interface TeleportMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  teleporters(): TeleporterSubsystem;
  teleportRoom(): TeleportRoom;
  sectorKey(): string | null;
  now(): number;
  storage(): Pick<StorageService, 'padLoad' | 'padUnload'>;
  rebuildStructuresSlice(): void;
  answerToll(pid: string, padId: number, answer: TollAnswer): void;
  resolveOwnerName(owner: string): string | null;
  relationCtx: RelationContext;
}

export function registerTeleportMessages(h: TeleportMessageHost): RoomFeature {
  // v4 T1 — teleporters: pair, unpair, fire, rules, pad load/unload. Every
  // message is owner-gated; a foreign / non-teleporter id is a silent no-op.
  const ownTeleporter = (client: Client, entityId: number): StructureRecord | null => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    const swarmRec = h.swarmRegistry.getByEntityId(entityId);
    const rec = swarmRec ? h.structureRegistry.get(swarmRec.id) : undefined;
    return owner && rec && rec.owner === owner && isTeleporterKind(rec.kind) ? rec : null;
  };
  const tpMessage = <T extends { entityId: number }>(
    type: string,
    schema: MessageSchema<T>,
    act: (rec: StructureRecord, msg: T, client: Client) => void,
  ): void => parsedMessage(h, type, schema, (msg, client) => {
    const rec = ownTeleporter(client, msg.entityId);
    if (rec) act(rec, msg, client);
  });
  tpMessage('teleport_pair', TeleportPairSchema, (rec, msg, client) => {
    const other = ownTeleporter(client, msg.partnerEntityId);
    if (other) h.teleporters().pair(rec, other);
  });
  // T3 — the sender's other teleporters, here and in every other sector.
  // Any teleporter (yours or someone else's, for a pair request): it lists
  // the SENDER's own teleporters.
  parsedMessage(h, 'teleport_candidates', TeleportCandidatesQuerySchema, (msg, client) => {
    const me = h.sessionToPlayer().get(client.sessionId);
    const sw = h.swarmRegistry.getByEntityId(msg.entityId);
    const rec = sw ? h.structureRegistry.get(sw.id) : undefined;
    if (!me || !rec || !isTeleporterKind(rec.kind)) return;
    const items: Array<{ sectorKey: string; uid: string; label: string }> = [];
    const here = h.sectorKey() ?? '';
    for (const r of h.teleportRoom().ownTeleporters(me)) {
      if (r === rec || r.uid === undefined) continue;
      const km = (Math.hypot(r.x - rec.x, r.y - rec.y) / 1000).toFixed(1);
      items.push({ sectorKey: here, uid: r.uid, label: `${getStructureKind(r.kind).displayName} · ${km} km` });
    }
    for (const { sectorKey, rec: r } of getTeleportBroker().ownTeleporters(me)) {
      if (sectorKey === here || r.uid === undefined) continue;
      const where = getSector(sectorKey)?.name ?? 'another sector';
      items.push({ sectorKey, uid: r.uid, label: `${getStructureKind(r.kind).displayName} · ${where}` });
    }
    client.send('teleport_candidates', { type: 'teleport_candidates', entityId: msg.entityId, items: items.slice(0, 200) });
  });
  // T4 — tolls: the owner sets one; riders answer the prompt.
  tpMessage('set_teleport_toll', SetTeleportTollSchema, (rec, msg) => {
    if (msg.toll === null || msg.toll.per1000 === 0) delete rec.tpToll;
    else rec.tpToll = { ...msg.toll };
    h.rebuildStructuresSlice();
  });
  parsedMessage(h, 'teleport_toll_answer', TollAnswerSchema, (msg, client) => {
    const pid = h.sessionToPlayer().get(client.sessionId);
    if (pid) h.answerToll(pid, msg.padId, msg.answer);
  });
  // T4 — ask another owner to pair their teleporter (here) with one of yours.
  parsedMessage(h, 'teleport_pair_request', TeleportPairRequestSchema, (msg, client) => {
    const pid = h.sessionToPlayer().get(client.sessionId);
    const sw = h.swarmRegistry.getByEntityId(msg.entityId);
    const target = sw ? h.structureRegistry.get(sw.id) : undefined;
    if (!pid || !target || !isTeleporterKind(target.kind) || !target.isConstructed || target.owner === pid || target.uid === undefined) return;
    // v4 A — alien gates only ever link to each other; v4 H — an NPC
    // teleporter is pre-linked by the transit network.
    if (isFreeTeleporterKind(target.kind) || isNpcOwner(target.owner)) return;
    if (relationOf(pid, target.owner, h.relationCtx) === 'hostile') return;
    const here = h.sectorKey() ?? '';
    const mine = msg.sectorKey === here
      ? h.teleporters().byUid(msg.uid)
      : getTeleportBroker().find(msg.sectorKey, msg.uid)?.rec ?? null;
    if (!mine || mine.owner !== pid || !mine.isConstructed) return;
    const id = randomUUID();
    getTeleportBroker().addRequest({
      id, targetSector: here, targetUid: target.uid, toOwner: target.owner,
      fromSector: msg.sectorKey, fromUid: msg.uid, fromOwner: pid, atMs: h.now(),
    });
    const fromName = h.resolveOwnerName(pid) ?? 'A pilot';
    const where = (sk: string): string => (sk === here ? 'here' : (getSector(sk)?.name ?? 'another sector'));
    const label = `their ${getStructureKind(mine.kind).displayName} (${where(msg.sectorKey)}) with your ${getStructureKind(target.kind).displayName} (${getSector(here)?.name ?? 'this sector'})`;
    getTeleportBroker().sendToPlayer(target.owner, 'teleport_pair_request', { type: 'teleport_pair_request', requestId: id, fromName, label } satisfies PairRequestPrompt);
  });
  parsedMessage(h, 'teleport_pair_answer', TeleportPairAnswerSchema, (msg, client) => {
    const pid = h.sessionToPlayer().get(client.sessionId);
    const broker = getTeleportBroker();
    const req = broker.takeRequest(msg.requestId, h.now());
    if (!pid || !req || req.toOwner !== pid || !msg.accept) return;
    const target = broker.find(req.targetSector, req.targetUid);
    const from = broker.find(req.fromSector, req.fromUid);
    if (!target || !from || target.rec.owner !== pid || from.rec.owner !== req.fromOwner) return;
    target.room.teleporters.pair(target.rec, from.rec, from.room.teleporters, true);
  });

  tpMessage('teleport_pair_remote', TeleportPairRemoteSchema, (rec, msg) => {
    if (msg.sectorKey === (h.sectorKey() ?? '')) {
      const other = h.teleporters().byUid(msg.uid);
      if (other && other.isConstructed) h.teleporters().pair(rec, other);
      return;
    }
    const f = getTeleportBroker().find(msg.sectorKey, msg.uid);
    if (f && f.rec.owner === rec.owner) h.teleporters().pair(rec, f.rec, f.room.teleporters);
  });
  tpMessage('teleport_unpair', TeleportUnpairSchema, (rec) => h.teleporters().unpair(rec));
  tpMessage('teleport_fire', TeleportFireSchema, (rec) => { h.teleporters().fire(rec, h.now()); });
  tpMessage('set_teleport_rules', SetTeleportRulesSchema, (rec, msg) => h.teleporters().setRules(rec, msg.rules));
  tpMessage('teleport_pad_load', TeleportPadLoadSchema, (rec, msg) => {
    if (!isTeleporterKind(rec.kind) || !rec.isConstructed) return;
    h.storage().padLoad(rec, msg.good, msg.qty, PAD_SPECS[rec.kind].padCapacity);
    h.rebuildStructuresSlice();
  });
  tpMessage('teleport_pad_unload', TeleportPadUnloadSchema, (rec) => {
    h.storage().padUnload(rec);
    h.rebuildStructuresSlice();
  });
  return {};
}

/** What the pad riders need from the room; getters read the live field. */
export interface TeleportRiderHost {
  sectorKey(): string | null;
  teleportRoom(): TeleportRoom;
  storage(): Pick<StorageService, 'padSwapAcross'>;
  playerToSlot(): ReadonlyMap<string, number>;
  playerToSession(): ReadonlyMap<string, string>;
  lingeringSlots: ReadonlyMap<string, number>;
  lingeringPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  shipPoseCache(): ReadonlyMap<string, ShipPhysicsState>;
  ships(): Pick<MapSchema<ShipState>, 'get'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'all'>;
  sabF32(): Float32Array;
  sabU32(): Uint32Array;
  getActiveShip(pid: string): ShipState | undefined;
  displaceActiveHullToLingering(pid: string): void;
  transitOrchestrator(): Pick<TransitOrchestrator, 'teleportOut'> | null;
  handOffHullsTo(toRoom: TeleportRoom, moves: readonly HullMove[], arrival: 'warp' | 'teleport'): string[];
  fleet: Pick<FleetCommandSubsystem, 'ordersOf'>;
  postToWorker(cmd: WorkerCmd): void;
  /** Keep snapshots flowing until this tick (`forceBroadcastUntilTick`). */
  forceBroadcastUntil(tick: number): void;
}

/**
 * v4 T2/T3 — who rides a teleporter jump and how they move: same-sector pad
 * swaps, the cross-sector swap through the broker (collect both ends, then
 * dispatch), the boarding count and the iris spans. Moved verbatim out of
 * `SectorRoom`; the hull hand-off itself is `HullHandOff.handOffHullsTo`
 * (`features/hullHandOff.ts`, shared with the fleet warp). Discrete events (once per jump).
 */
export class TeleportPadRiders {
  constructor(private readonly h: TeleportRiderHost) {}

  /** Hops to another sector for the jump charge. Rooms outside the galaxy
   *  graph (tests) that the broker knows count as one hop. */
  hopsToSector(sectorKey: string): number {
    const here = this.h.sectorKey();
    if (here === null) return Infinity;
    if (getSector(here) && getSector(sectorKey)) return hopDistance(here, sectorKey);
    return getTeleportBroker().room(sectorKey) !== null ? 1 : Infinity;
  }

  /** The jump across sectors: the pad holds trade in one group, then both
   *  pads' riders are collected BEFORE either side is sent (nobody rides twice). */
  swapAcross(a: StructureRecord, link: PartnerLink): void {
    const other = a.tpPartner ? getTeleportBroker().room(a.tpPartner.sectorKey) : null;
    if (other === null) return;
    this.h.storage().padSwapAcross(a, other.storage, link.rec);
    const mine = this.collectRiders(a);
    const theirs = other.collectRiders(link.rec);
    this.dispatchRiders(mine, other, link.rec);
    other.dispatchRiders(theirs, this.h.teleportRoom(), a);
    serverLogEvent('teleport_swap_across', {
      from: this.h.sectorKey() ?? '', to: other.sectorKey ?? '',
      out: mine.pilots.length + mine.hulls.length + mine.bots.length,
      in: theirs.pilots.length + theirs.hulls.length + theirs.bots.length,
    });
  }

  /** Who is on a pad (#17 by class: ACTIVE alive pilots, LINGERING hulls,
   *  NPC ships), as offsets from its centre. A discrete event per jump. */
  collectRiders(from: StructureRecord): RiderBatch {
    const sabF32 = this.h.sabF32();
    const batch: RiderBatch = { pilots: [], hulls: [], bots: [] };
    if (!isTeleporterKind(from.kind)) return batch;
    const kind = from.kind;
    const disconnected: string[] = [];
    for (const [pid, slot] of this.h.playerToSlot()) {
      const ship = this.h.getActiveShip(pid);
      if (!ship?.alive) continue;
      const sb = slotBase(slot);
      const x = sabF32[sb + SLOT_X_OFF]!;
      const y = sabF32[sb + SLOT_Y_OFF]!;
      if (!onPad(kind, from.x, from.y, x, y, padAngle(from))) continue;
      if (ship.isActive) batch.pilots.push({ playerId: pid, dx: x - from.x, dy: y - from.y });
      // A disconnected pilot's hull lingers under their id; a connected but
      // inactive hull is a pending join and stays (#17).
      else if (!this.h.playerToSession().has(pid)) disconnected.push(pid);
    }
    // Disconnected hulls become ordinary parked hulls, so they ride below.
    for (const pid of disconnected) this.h.displaceActiveHullToLingering(pid);
    for (const [sid, slot] of this.h.lingeringSlots) {
      const ship = this.h.ships().get(sid);
      if (!ship || !ship.alive) continue;
      const sb = slotBase(slot);
      const x = sabF32[sb + SLOT_X_OFF]!;
      const y = sabF32[sb + SLOT_Y_OFF]!;
      if (!onPad(kind, from.x, from.y, x, y, padAngle(from))) continue;
      batch.hulls.push({
        shipInstanceId: sid, playerId: ship.playerId, kind: ship.kind,
        dx: x - from.x, dy: y - from.y,
        vx: sabF32[sb + SLOT_VX_OFF]!, vy: sabF32[sb + SLOT_VY_OFF]!,
        angle: sabF32[sb + SLOT_ANGLE_OFF]!, angvel: sabF32[sb + SLOT_ANGVEL_OFF]!,
        health: ship.health, shieldDown: ship.shield <= 0,
      });
    }
    for (const rec of this.h.swarmRegistry.all()) {
      if (rec.kind !== 1) continue;
      const sb = slotBase(rec.slot);
      const x = sabF32[sb + SLOT_X_OFF]!;
      const y = sabF32[sb + SLOT_Y_OFF]!;
      if (onPad(kind, from.x, from.y, x, y, padAngle(from))) batch.bots.push({ botId: rec.id, dx: x - from.x, dy: y - from.y });
    }
    return batch;
  }

  /** Send a batch to another sector's pad: pilots by an instant transit,
   *  parked hulls rebuilt there (their roster row moves sector), NPC bots
   *  through their director (a bot no director owns stays behind). */
  dispatchRiders(batch: RiderBatch, toRoom: TeleportRoom, to: StructureRecord): void {
    const dest = toRoom.sectorKey;
    const here = this.h.sectorKey();
    if (dest === null || here === null) return;
    for (const p of batch.pilots) {
      this.h.transitOrchestrator()?.teleportOut(p.playerId, dest, { x: to.x + p.dx, y: to.y + p.dy });
    }
    if (batch.hulls.length > 0) {
      const moves: HullMove[] = [];
      for (const h of batch.hulls) {
        moves.push({
          shipInstanceId: h.shipInstanceId, x: to.x + h.dx, y: to.y + h.dy,
          vx: h.vx, vy: h.vy, angle: h.angle, angvel: h.angvel,
        });
      }
      this.h.handOffHullsTo(toRoom, moves, 'teleport');
    }
    for (const b of batch.bots) {
      getTeleportBroker().moveBot(b.botId, here, dest, to.x + b.dx, to.y + b.dy);
    }
  }

  /** v4 T1 — how many ACTIVE, alive player ships (#17: lingering hulls and
   *  the dead don't board) sit with their centre on this teleporter's pad. */
  shipsOnPad(rec: StructureRecord): number {
    if (!isTeleporterKind(rec.kind)) return 0;
    let n = 0;
    for (const [pid] of this.h.playerToSlot()) {
      const ship = this.h.getActiveShip(pid);
      if (!ship?.alive || !ship.isActive) continue;
      const pose = this.h.shipPoseCache().get(pid);
      if (pose && onPad(rec.kind, rec.x, rec.y, pose.x, pose.y, padAngle(rec))) n++;
    }
    return n;
  }

  /** T2 — call `fn` with each iris span's worker id and its offset from the
   *  pad centre (`padIrisSpanLocal`; the seal is a round polygon of a
   *  multiple of 4 chords, so a quarter turn leaves it unchanged). Only the
   *  Ancients' gate has an iris, its sealed inner ring (redesign A3): a
   *  chamber pad (redesign T2) is sealed by its blast-door leaves
   *  (`padDoors.ts`). */
  forIrisSpan(rec: StructureRecord, fn: (id: string, s: { ax: number; ay: number; bx: number; by: number }) => void): void {
    if (!isTeleporterKind(rec.kind) || isPadChamberKind(rec.kind)) return;
    const n = padIrisSpanCount(rec.kind);
    for (let i = 0; i < n; i++) {
      padIrisSpanLocal(rec.kind, i, this._irisSpan);
      fn(`tpiris-${rec.id}-${i}`, this._irisSpan);
    }
  }
  private readonly _irisSpan = { ax: 0, ay: 0, bx: 0, by: 0 };

  /**
   * T2 — the jump: everything on pad `a` goes to pad `b` and everything on
   * `b` comes to `a`, each at the same offset from its pad's centre. Riders,
   * by liveness class (#17): ACTIVE alive player ships, LINGERING hulls, and
   * NPC ships and scrap (swarm kinds 1 and 3). Everyone rides, strangers too
   * (user ruling). Collected first, then moved, so nobody rides twice. An
   * active player's `poseEpoch` bumps so their client re-seeds its prediction.
   * A discrete event (once per jump), so its small arrays are fine.
   */
  swapPadShips(a: StructureRecord, b: StructureRecord): void {
    const sabF32 = this.h.sabF32();
    if (!isTeleporterKind(a.kind) || !isTeleporterKind(b.kind)) return;
    const moves: Array<{ bodyKey: string; slot: number; nx: number; ny: number; playerId?: string; lingerId?: string }> = [];
    const pairs: Array<[StructureRecord, StructureRecord]> = [[a, b], [b, a]];
    for (const [from, to] of pairs) {
      const kind = from.kind as TeleporterKind;
      for (const [pid, slot] of this.h.playerToSlot()) {
        const ship = this.h.getActiveShip(pid);
        if (!ship?.alive) continue;
        // Active pilots and disconnected pilots' parked hulls ride; a connected
        // but inactive hull is a pending join and stays (#17).
        if (!ship.isActive && this.h.playerToSession().has(pid)) continue;
        const sb = slotBase(slot);
        const x = sabF32[sb + SLOT_X_OFF]!;
        const y = sabF32[sb + SLOT_Y_OFF]!;
        if (onPad(kind, from.x, from.y, x, y, padAngle(from))) moves.push({ bodyKey: pid, slot, nx: to.x + x - from.x, ny: to.y + y - from.y, playerId: pid });
      }
      for (const [sid, slot] of this.h.lingeringSlots) {
        const sb = slotBase(slot);
        const x = sabF32[sb + SLOT_X_OFF]!;
        const y = sabF32[sb + SLOT_Y_OFF]!;
        if (onPad(kind, from.x, from.y, x, y, padAngle(from))) moves.push({ bodyKey: `linger-${sid}`, slot, nx: to.x + x - from.x, ny: to.y + y - from.y, lingerId: sid });
      }
      for (const rec of this.h.swarmRegistry.all()) {
        if (rec.kind !== 1 && rec.kind !== 3) continue;
        const sb = slotBase(rec.slot);
        const x = sabF32[sb + SLOT_X_OFF]!;
        const y = sabF32[sb + SLOT_Y_OFF]!;
        if (onPad(kind, from.x, from.y, x, y, padAngle(from))) moves.push({ bodyKey: rec.id, slot: rec.slot, nx: to.x + x - from.x, ny: to.y + y - from.y });
      }
    }
    for (const m of moves) {
      const sb = slotBase(m.slot);
      sabF32[sb + SLOT_X_OFF] = m.nx;
      sabF32[sb + SLOT_Y_OFF] = m.ny;
      this.h.postToWorker({
        type: 'SET_POSITION', entityId: m.bodyKey, x: m.nx, y: m.ny,
        angle: sabF32[sb + SLOT_ANGLE_OFF]!, vx: sabF32[sb + SLOT_VX_OFF]!,
        vy: sabF32[sb + SLOT_VY_OFF]!, angvel: sabF32[sb + SLOT_ANGVEL_OFF]!,
      });
      if (m.playerId !== undefined) {
        const pose = this.h.shipPoseCache().get(m.playerId);
        if (pose) { pose.x = m.nx; pose.y = m.ny; }
        const ship = this.h.getActiveShip(m.playerId);
        if (ship) ship.poseEpoch++;
      }
      if (m.lingerId !== undefined) {
        const pose = this.h.lingeringPoseCache.get(m.lingerId);
        if (pose) {
          // RTS slice 4: a wingman's guard post rides the jump with its hull,
          // or the brain would fly straight back to the old pad.
          const w = this.h.fleet.ordersOf(m.lingerId);
          if (w !== null && w.guardPostX !== null && w.guardPostY !== null) {
            w.guardPostX += m.nx - pose.x;
            w.guardPostY += m.ny - pose.y;
          }
          pose.x = m.nx; pose.y = m.ny;
        }
      }
    }
    if (moves.length > 0) {
      // Keep snapshots flowing so the riders' clients reconcile at once.
      this.h.forceBroadcastUntil(Atomics.load(this.h.sabU32(), TICK_IDX) + JOIN_BROADCAST_GRACE_TICKS);
      serverLogEvent('teleport_swap', { sectorKey: this.h.sectorKey() ?? '', riders: moves.length });
    }
  }
}

/** What building the room's teleporters needs; getters read the live field. */
export interface TeleporterBuildHost extends Pick<TeleportRoom, 'canReceiveHull' | 'receiveLingeringHull' | 'receiveFleetSquads' | 'sendToPlayer'> {
  structureRegistry: StructureRegistry;
  storage(): StorageService;
  sectorKey(): string | null;
  /** The test-room phase speed-up (`teleportCycleScale`); undefined = real time. */
  testCycleScale: number | undefined;
  powered(id: string): boolean;
  padRiders: TeleportPadRiders;
  tolls: Pick<TeleportTolls, 'offerToll' | 'settleToll'>;
  forceFields: Pick<ForceFieldSubsystem, 'set' | 'remove'>;
  rebuildStructuresSlice(): void;
  postToWorker(cmd: WorkerCmd): void;
  /** Redesign T2 — the chamber pads' blast doors. */
  padDoors?: PadDoors;
}

/**
 * v4 T1-T4 — build the room's `TeleporterSubsystem` and the `TeleportRoom` the
 * broker reaches it through from other sectors, then register that room with
 * the broker. Moved verbatim out of `SectorRoom.onCreate`, which calls it at the
 * same point (before the startup seeding that places alien gates and pads).
 */
export function buildTeleporters(h: TeleporterBuildHost): { teleporters: TeleporterSubsystem; teleportRoom: TeleportRoom } {
  const tpScale = h.testCycleScale !== undefined ? Math.max(0.001, Math.min(1, h.testCycleScale)) : 1;
  const gateTwinHost: GateTwinHost = { sectorKey: h.sectorKey, structureRegistry: () => h.structureRegistry };
  const sectorKey = h.sectorKey();
  const storage = h.storage();
  let teleportRoom: TeleportRoom | undefined;
  const teleporters = new TeleporterSubsystem({
    registry: h.structureRegistry,
    storage,
    sectorKey: h.sectorKey,
    isPowered: (rec) => rec.isConstructed && h.powered(rec.id),
    cycleScale: () => tpScale,
    shipsOnPad: (rec) => h.padRiders.shipsOnPad(rec),
    onChanged: () => h.rebuildStructuresSlice(),
    // T2 — ships ride the swap; the iris and the closing push in the worker.
    onSwapShips: (a, b) => h.padRiders.swapPadShips(a, b),
    // T3 — partners in other sectors, reached through the broker.
    onSwapRemote: (a, link) => h.padRiders.swapAcross(a, link),
    remoteFind: (sk, uid) => {
      const f = getTeleportBroker().find(sk, uid);
      return f && f.room !== teleportRoom ? { rec: f.rec, sys: f.room.teleporters } : null;
    },
    hopsTo: (sk) => h.padRiders.hopsToSector(sk),
    findAlienTwin: (rec) => findAlienTwin(gateTwinHost, rec),
    findLinkTwin: (rec) => findLinkTwin(gateTwinHost, rec),
    // T4 — tolls: offered at arming, settled at the swap.
    onArmed: (rec) => h.tolls.offerToll(rec),
    onTollSettle: (rec) => h.tolls.settleToll(rec),
    spawnIris: (rec) => h.padRiders.forIrisSpan(rec, (id, s) => {
      h.postToWorker({ type: 'SPAWN_WALL', id, ax: rec.x + s.ax, ay: rec.y + s.ay, bx: rec.x + s.bx, by: rec.y + s.by, thickness: GATE_SPAN_THICKNESS });
      h.postToWorker({ type: 'SET_WALL_ACTIVE', id, active: false });
    }),
    setIrisActive: (rec, active) => h.padRiders.forIrisSpan(rec, (id) => h.postToWorker({ type: 'SET_WALL_ACTIVE', id, active })),
    removeIris: (rec) => {
      h.padRiders.forIrisSpan(rec, (id) => h.postToWorker({ type: 'REMOVE_WALL', id }));
      h.forceFields.remove(`tpfield-${rec.id}`);
    },
    padDoors: h.padDoors,
    setPadField: (rec, active) => {
      if (!isTeleporterKind(rec.kind)) return;
      // A chamber pushes only along its doorway axis (`padPushDir` doorAngle).
      const doorAngle = isPadChamberKind(rec.kind) ? padAngle(rec) : undefined;
      // The Ancients' gate pushes along the radius at its round seal (A3).
      h.forceFields.set(`tpfield-${rec.id}`, { kind: 'pad', cx: rec.x, cy: rec.y, half: padPushHalf(rec.kind), active, doorAngle, round: isRoundPadKind(rec.kind) });
    },
  });
  // v4 T3 — the broker reaches this room's teleporters from other sectors.
  teleportRoom = {
    sectorKey,
    teleporters,
    storage,
    teleporterByUid: (uid) => {
      const r = teleporters.byUid(uid);
      return r && r.isConstructed ? r : null;
    },
    structures: () => h.structureRegistry.all(),
    ownTeleporters: (owner) => {
      const out: StructureRecord[] = [];
      for (const r of h.structureRegistry.all()) {
        if (r.owner === owner && r.isConstructed && isTeleporterKind(r.kind)) out.push(r);
      }
      return out;
    },
    collectRiders: (from) => h.padRiders.collectRiders(from),
    dispatchRiders: (batch, toRoom, to) => h.padRiders.dispatchRiders(batch, toRoom, to),
    canReceiveHull: (shipInstanceId) => h.canReceiveHull(shipInstanceId),
    receiveLingeringHull: (row) => h.receiveLingeringHull(row),
    receiveFleetSquads: (rows) => h.receiveFleetSquads(rows),
    sendToPlayer: (pid, type, msg) => h.sendToPlayer(pid, type, msg),
  };
  if (sectorKey !== null) getTeleportBroker().register(teleportRoom);
  return { teleporters, teleportRoom };
}

/** Test cue (`test_gate_seal`, teleporter redesign A3): hold every Ancients'
 *  gate in the room SEALED (its inner ring solid) or IDLE. The gate is not
 *  its cycle's initiator, so `update` leaves the held phase alone. */
export function holdAlienGatesSealed(reg: StructureRegistry, tp: TeleporterSubsystem, sealed: boolean): void {
  for (const rec of reg.all()) {
    if (!isAlienGateKind(rec.kind) || rec.tpInitiator === true) continue;
    tp.setPhase(rec, sealed ? TP_PHASE.SEALED : TP_PHASE.IDLE, 0);
  }
}
