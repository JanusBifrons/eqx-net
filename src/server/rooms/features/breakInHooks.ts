/**
 * C2/C3 — what the room does when a break-in starts or ends (hostile act,
 * standing, NPC aggro, owner alerts, audit) and how long one takes. Moved
 * verbatim out of `SectorRoom`; `BreakInSubsystem` calls `onBreakInStart` /
 * `onBreakInEnd`, and the room hands in live accessors. Discrete events.
 * Also the C3 ship cargo targets a break-in or a cargo request names
 * (`shipTarget`, `shipTargetById`) and the cargo-range check
 * (`pilotNearPoint`), moved verbatim out of `SectorRoom` too.
 */
import type { Client } from 'colyseus';
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { SectorState, ShipState } from '../schema/SectorState.js';
import type { CargoShipTarget } from './cargoMessages.js';
import { isHaulerId } from '../../livingworld/directorBotIds.js';
import type { HostileActLedger } from '../../../core/relations/HostileActLedger.js';
import type { AiController } from '../../../core/ai/AiController.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import { pushNotifier } from '../../push/PushNotifier.js';
import { npcOwner, parseOwner, type RelationContext } from '../../../shared-types/relations.js';
import { CARGO_ACCESS_RANGE, type BreakInNotice } from '../../../shared-types/messages/cargoMessages.js';
import { breakInDurationMs } from '../../../shared-types/breakIn.js';
import { allegianceOfKind, getShipKind, type ShipKindId } from '../../../shared-types/shipKinds.js';
import { ON_SIGHT_ENGAGE_RANGE, type NpcAllegianceId } from '../../../shared-types/allegiances.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF } from '../../../shared-types/sabLayout.js';
import { STANDING_BREAK_IN_DELTA } from '../../../shared-types/factions.js';

/** C3 — how much you can unload into an NPC ship's hold. */
const NPC_HOLD_CAPACITY = 1000;

/** What the hooks need from the room; getters read the live field. */
export interface BreakInHookHost {
  testBreakInMs(): number | null;
  playerToSession: ReadonlyMap<string, string>;
  clients(): ReadonlyArray<Client>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'all'>;
  sabF32(): Float32Array;
  hostileActs: Pick<HostileActLedger, 'record'>;
  relationCtx: RelationContext;
  aiController(): Pick<AiController, 'markHostile'>;
  now(): number;
  serverTick(): number;
  sectorKey(): string | null;
  adjustStanding(from: string, to: string, delta: number): void;
  resolveOwnerName(owner: string): string | null;
  swarmGet(id: string): SwarmEntityRecord | null;
  swarmByEntityId(entityId: number): SwarmEntityRecord | null;
  state(): Pick<SectorState, 'ships'>;
  getActiveShip(playerId: string): ShipState | undefined;
  playerToSlot(): ReadonlyMap<string, number>;
  shipPoseCache(): ReadonlyMap<string, ShipPhysicsState>;
  lingeringSlots: ReadonlyMap<string, number>;
  lingeringPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  shipCargoCapacity(kind: string, shipInstanceId: string): number;
  broadcast(type: string, msg: unknown): void;
  rebuildStructuresSlice(): void;
}

export class BreakInHooks {
  constructor(private readonly h: BreakInHookHost) {}

  /** C2 — how long a break-in into `rec` takes. */
  breakInMsFor(rec: StructureRecord): number {
    return this.h.testBreakInMs() ?? breakInDurationMs(getStructureKind(rec.kind).holdCapacity ?? 0, rec.level ?? 1);
  }

  /** C3 — every ship cargo can target: an NPC ship (by its swarm record), a
   *  player's ACTIVE ship (by playerId), or a parked hull (by shipInstanceId).
   *  `id` keys break-ins and grants; `holdUid` keys the hold. */
  shipTarget(ref: { entityId?: number; ship?: string }): CargoShipTarget | null {
    if (ref.entityId !== undefined) {
      const rec = this.h.swarmByEntityId(ref.entityId);
      return rec && rec.kind === 1 ? this.npcShipTarget(rec) : null;
    }
    const key = ref.ship!;
    const active = this.h.getActiveShip(key);
    if (active?.alive && active.isActive && active.shipInstanceId !== '') {
      const pose = this.h.shipPoseCache().get(key);
      if (!pose) return null;
      return {
        id: active.shipInstanceId, holdUid: active.shipInstanceId, owner: key, x: pose.x, y: pose.y,
        radius: getShipKind(active.kind).radius, capacity: this.h.shipCargoCapacity(active.kind, active.shipInstanceId),
        label: getShipKind(active.kind).displayName, persisted: true,
      };
    }
    if (this.h.lingeringSlots.has(key)) {
      const st = this.h.state().ships.get(key);
      const pose = this.h.lingeringPoseCache.get(key);
      if (!st || !pose) return null;
      return {
        id: key, holdUid: key, owner: st.playerId, x: pose.x, y: pose.y, radius: getShipKind(st.kind).radius,
        capacity: this.h.shipCargoCapacity(st.kind, key), label: getShipKind(st.kind).displayName, persisted: true,
      };
    }
    return null;
  }

  private npcShipTarget(rec: SwarmEntityRecord): CargoShipTarget {
    const b = slotBase(rec.slot);
    return {
      id: rec.id, holdUid: rec.id, owner: npcOwner(allegianceOfKind(rec.shipKind)),
      x: this.h.sabF32()[b + SLOT_X_OFF]!, y: this.h.sabF32()[b + SLOT_Y_OFF]!, radius: rec.radius,
      capacity: NPC_HOLD_CAPACITY, label: getShipKind(rec.shipKind as ShipKindId).displayName,
      persisted: isHaulerId(rec.id), npc: rec,
    };
  }

  /** C3 — a break-in / grant key back to its ship target (or null). */
  shipTargetById(id: string): CargoShipTarget | null {
    const rec = this.h.swarmGet(id);
    if (rec && rec.kind === 1) return this.npcShipTarget(rec);
    for (const [pid] of this.h.playerToSlot()) if (this.h.getActiveShip(pid)?.shipInstanceId === id) return this.shipTarget({ ship: pid });
    return this.h.lingeringSlots.has(id) ? this.shipTarget({ ship: id }) : null;
  }

  /** C2/C3 — is `playerId`'s live ship within cargo range of a point body? */
  pilotNearPoint(playerId: string, x: number, y: number, radius: number): boolean {
    const ship = this.h.getActiveShip(playerId);
    const pose = this.h.shipPoseCache().get(playerId);
    if (!ship?.alive || !ship.isActive || !pose) return false;
    const reach = CARGO_ACCESS_RANGE + radius;
    return (pose.x - x) ** 2 + (pose.y - y) ** 2 <= reach * reach;
  }

  /** C3 — how long breaking into a ship takes. */
  breakInMsForShip(t: Pick<CargoShipTarget, 'capacity'>): number {
    return this.h.testBreakInMs() ?? breakInDurationMs(Number.isFinite(t.capacity) ? t.capacity : 1000, 1);
  }

  private notifyBreakIn(playerId: string, tone: 'good' | 'danger', message: string): void {
    const sessionId = this.h.playerToSession.get(playerId);
    if (sessionId === undefined) return;
    const client = this.h.clients().find((c) => c.sessionId === sessionId);
    const msg: BreakInNotice = { type: 'break_in_notice', tone, message };
    try { client?.send('break_in_notice', msg); } catch { /* closing */ }
  }

  /**
   * C2 — a break-in started: it is a HOSTILE ACT (the owner's turrets now
   * engage the actor; an NPC side's ships nearby turn on them), and the owner
   * is alerted (online: a notice; offline: a push).
   */
  onBreakInStart(actor: string, sid: string): void {
    const rec = this.h.structureRegistry.get(sid);
    if (!rec) { this.onShipBreakInStart(actor, sid); return; }
    const now = this.h.now();
    this.h.hostileActs.record(actor, rec.owner, now);
    this.h.relationCtx.nowMs = now;
    this.h.adjustStanding(parseOwner(rec.owner).faction, actor, STANDING_BREAK_IN_DELTA);
    const kindName = getStructureKind(rec.kind).displayName;
    const who = this.h.resolveOwnerName(actor) ?? 'A pilot';
    const party = parseOwner(rec.owner);
    if (party.kind === 'npc' && party.allegiance != null) {
      this.aggroNpcSide(party.allegiance, rec.x, rec.y, actor);
    } else if (party.kind === 'player') {
      const text = `${who} is breaking into your ${kindName}!`;
      this.notifyBreakIn(rec.owner, 'danger', text);
      pushNotifier.notifyTrade(rec.owner, 'Break-in!', text, 'break-in');
    }
    auditEvent({ event: 'break_in', sector: this.h.sectorKey() ?? undefined, playerId: actor, owner: rec.owner, structureKind: rec.kind, outcome: 'started' });
    this.h.rebuildStructuresSlice(); // the BREACH flag
  }

  /** C2/C3 — an NPC side's ships near (x, y) turn on `actor` (ledger + bot_aggro). */
  private aggroNpcSide(allegiance: NpcAllegianceId, x: number, y: number, actor: string): void {
    const tick = this.h.serverTick();
    const r2 = ON_SIGHT_ENGAGE_RANGE * ON_SIGHT_ENGAGE_RANGE;
    const sabF32 = this.h.sabF32();
    for (const s of this.h.swarmRegistry.all()) {
      if (s.kind !== 1 || allegianceOfKind(s.shipKind) !== allegiance) continue;
      const b = slotBase(s.slot);
      if ((sabF32[b + SLOT_X_OFF]! - x) ** 2 + (sabF32[b + SLOT_Y_OFF]! - y) ** 2 > r2) continue;
      this.h.aiController().markHostile(s.id, actor, tick);
      this.h.broadcast('bot_aggro', { type: 'bot_aggro', botEntityId: `swarm-${s.entityId}`, targetPlayerId: actor, tick });
    }
  }

  /** C3 — breaking into a ship: a hostile act against its owner / NPC side. */
  private onShipBreakInStart(actor: string, sid: string): void {
    const t = this.shipTargetById(sid);
    if (!t) return;
    const now = this.h.now();
    this.h.hostileActs.record(actor, t.owner, now);
    this.h.relationCtx.nowMs = now;
    this.h.adjustStanding(parseOwner(t.owner).faction, actor, STANDING_BREAK_IN_DELTA);
    if (t.npc) {
      this.aggroNpcSide(allegianceOfKind(t.npc.shipKind), t.x, t.y, actor);
    } else {
      const text = `${this.h.resolveOwnerName(actor) ?? 'A pilot'} is breaking into your ${t.label}!`;
      this.notifyBreakIn(t.owner, 'danger', text);
      pushNotifier.notifyTrade(t.owner, 'Break-in!', text, 'break-in');
    }
    auditEvent({ event: 'break_in', sector: this.h.sectorKey() ?? undefined, playerId: actor, owner: t.owner, structureKind: `ship:${t.label}`, outcome: 'started' });
  }

  onBreakInEnd(actor: string, sid: string, outcome: 'success' | 'interrupted', reason: string): void {
    const rec = this.h.structureRegistry.get(sid);
    if (!rec && outcome === 'success') {
      const t = this.shipTargetById(sid);
      if (t && !t.npc) this.notifyBreakIn(t.owner, 'danger', `Your ${t.label} was broken into!`);
    }
    this.notifyBreakIn(actor, outcome === 'success' ? 'good' : 'danger', outcome === 'success' ? 'You are in. The cargo is open for a minute.' : `Break-in failed: ${reason}`);
    if (rec && parseOwner(rec.owner).kind === 'player' && outcome === 'success') {
      this.notifyBreakIn(rec.owner, 'danger', `Your ${getStructureKind(rec.kind).displayName} was broken into!`);
    }
    auditEvent({ event: 'break_in', sector: this.h.sectorKey() ?? undefined, playerId: actor, owner: rec?.owner ?? '', structureKind: rec?.kind ?? '', outcome: outcome === 'success' ? 'success' : 'interrupted' });
    this.h.rebuildStructuresSlice();
  }
}
