/**
 * Teleporter client messages — pair, unpair, fire, rules, tolls, pad
 * load/unload and cross-sector pair requests (v4 T1-T4), plus the pad riders
 * (`TeleportPadRiders`: who rides a jump and how they move). Moved verbatim out
 * of `SectorRoom.onCreate`; the room hands in live accessors so every handler
 * reads the same state it did when it lived there.
 */
import type { Client } from 'colyseus';
import { randomUUID } from 'node:crypto';
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import type { PartnerLink, TeleporterSubsystem } from '../../structures/TeleporterSubsystem.js';
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
import { getSector } from '../../../core/galaxy/galaxy.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { isNpcOwner, relationOf, type RelationContext } from '../../../shared-types/relations.js';
import {
  isFreeTeleporterKind,
  isTeleporterKind,
  onPad,
  padIrisSpanLocal,
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
 * `SectorRoom`; the hull hand-off itself stays the room's `handOffHullsTo`
 * (shared with the fleet warp). Discrete events (once per jump).
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
      if (!onPad(kind, from.x, from.y, x, y)) continue;
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
      if (!onPad(kind, from.x, from.y, x, y)) continue;
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
      if (onPad(kind, from.x, from.y, x, y)) batch.bots.push({ botId: rec.id, dx: x - from.x, dy: y - from.y });
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
      if (pose && onPad(rec.kind, rec.x, rec.y, pose.x, pose.y)) n++;
    }
    return n;
  }

  /** T2 — call `fn` with each iris span's worker id and its offset from the
   *  pad centre (the pad is square, so a quarter turn leaves them unchanged). */
  forIrisSpan(rec: StructureRecord, fn: (id: string, s: { ax: number; ay: number; bx: number; by: number }) => void): void {
    if (!isTeleporterKind(rec.kind)) return;
    const n = PAD_SPECS[rec.kind].posts;
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
        if (onPad(kind, from.x, from.y, x, y)) moves.push({ bodyKey: pid, slot, nx: to.x + x - from.x, ny: to.y + y - from.y, playerId: pid });
      }
      for (const [sid, slot] of this.h.lingeringSlots) {
        const sb = slotBase(slot);
        const x = sabF32[sb + SLOT_X_OFF]!;
        const y = sabF32[sb + SLOT_Y_OFF]!;
        if (onPad(kind, from.x, from.y, x, y)) moves.push({ bodyKey: `linger-${sid}`, slot, nx: to.x + x - from.x, ny: to.y + y - from.y, lingerId: sid });
      }
      for (const rec of this.h.swarmRegistry.all()) {
        if (rec.kind !== 1 && rec.kind !== 3) continue;
        const sb = slotBase(rec.slot);
        const x = sabF32[sb + SLOT_X_OFF]!;
        const y = sabF32[sb + SLOT_Y_OFF]!;
        if (onPad(kind, from.x, from.y, x, y)) moves.push({ bodyKey: rec.id, slot: rec.slot, nx: to.x + x - from.x, ny: to.y + y - from.y });
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
