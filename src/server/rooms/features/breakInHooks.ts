/**
 * C2/C3 — what the room does when a break-in starts or ends (hostile act,
 * standing, NPC aggro, owner alerts, audit) and how long one takes. Moved
 * verbatim out of `SectorRoom`; `BreakInSubsystem` calls `onBreakInStart` /
 * `onBreakInEnd`, and the room hands in live accessors. Discrete events.
 */
import type { Client } from 'colyseus';
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { HostileActLedger } from '../../../core/relations/HostileActLedger.js';
import type { AiController } from '../../../core/ai/AiController.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import { pushNotifier } from '../../push/PushNotifier.js';
import { parseOwner, type RelationContext } from '../../../shared-types/relations.js';
import type { BreakInNotice } from '../../../shared-types/messages/cargoMessages.js';
import { breakInDurationMs } from '../../../shared-types/breakIn.js';
import { allegianceOfKind } from '../../../shared-types/shipKinds.js';
import { ON_SIGHT_ENGAGE_RANGE, type NpcAllegianceId } from '../../../shared-types/allegiances.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF } from '../../../shared-types/sabLayout.js';
import { STANDING_BREAK_IN_DELTA } from '../../../shared-types/factions.js';

/** The part of a C3 ship cargo target the hooks read (`SectorRoom.shipTargetById`). */
export interface BreakInShipTarget {
  owner: string;
  x: number;
  y: number;
  label: string;
  npc?: SwarmEntityRecord;
}

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
  shipTargetById(id: string): BreakInShipTarget | null;
  broadcast(type: string, msg: unknown): void;
  rebuildStructuresSlice(): void;
}

export class BreakInHooks {
  constructor(private readonly h: BreakInHookHost) {}

  /** C2 — how long a break-in into `rec` takes. */
  breakInMsFor(rec: StructureRecord): number {
    return this.h.testBreakInMs() ?? breakInDurationMs(getStructureKind(rec.kind).holdCapacity ?? 0, rec.level ?? 1);
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
    const t = this.h.shipTargetById(sid);
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
      const t = this.h.shipTargetById(sid);
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
