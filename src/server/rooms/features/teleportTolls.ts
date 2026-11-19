/**
 * v4 T4 — teleporter tolls: offered when a pad arms, answered by riders,
 * settled at the swap. Moved verbatim out of `SectorRoom` with the per-pad
 * answer state; the room hands in live accessors so every step reads the
 * same state it did there. Discrete events (once per arming / answer / swap).
 */
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { TeleporterSubsystem } from '../../structures/TeleporterSubsystem.js';
import type { HostileActLedger } from '../../../core/relations/HostileActLedger.js';
import type { ShipState } from '../schema/SectorState.js';
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { getWallet } from '../../db/PersistenceWorker.js';
import { getTradeSink } from '../../economy/tradeSink.js';
import { parseOwner, relationOf, type RelationContext } from '../../../shared-types/relations.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF } from '../../../shared-types/sabLayout.js';
import { TOLL_DODGE_STANDING, tollFor, onPad, isTeleporterKind, type TollAnswer, type TollPrompt } from '../../../shared-types/teleport.js';

/** What the toll steps need from the room; getters read the live field. */
export interface TeleportTollHost {
  playerToSlot(): ReadonlyMap<string, number>;
  sabF32(): Float32Array;
  getActiveShip(pid: string): ShipState | undefined;
  teleporters(): Pick<TeleporterSubsystem, 'required'>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'get' | 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  relationCtx: RelationContext;
  hostileActs: Pick<HostileActLedger, 'record'>;
  now(): number;
  sectorKey(): string | null;
  resolveOwnerName(owner: string): string | null;
  sendToPlayerHere(pid: string, type: string, msg: unknown): boolean;
  adjustStanding(from: string, to: string, delta: number): void;
}

export class TeleportTolls {
  /** T4 — per armed pad (structure id): the toll and each rider's answer. */
  private readonly tollAnswers = new Map<string, { credits: number; answers: Map<string, 'paid' | 'declined' | 'pending'> }>();

  constructor(private readonly h: TeleportTollHost) {}

  /** A pad armed: offer its toll to every rider on it who isn't the owner or
   *  their friend/ally. A remembered Always pays at once, a Never declines. */
  offerToll(rec: StructureRecord): void {
    this.tollAnswers.delete(rec.id);
    const toll = rec.tpToll;
    if (!toll || toll.per1000 <= 0 || !isTeleporterKind(rec.kind)) return;
    const credits = tollFor(this.h.teleporters().required(rec), toll.per1000);
    if (credits <= 0) return;
    const ownerFaction = parseOwner(rec.owner).faction;
    const ownerName = this.h.resolveOwnerName(rec.owner) ?? 'the owner';
    const padId = this.h.swarmRegistry.get(rec.id)?.entityId ?? -1;
    const answers = new Map<string, 'paid' | 'declined' | 'pending'>();
    this.tollAnswers.set(rec.id, { credits, answers });
    const sink = getTradeSink();
    const sabF32 = this.h.sabF32();
    for (const [pid, slot] of this.h.playerToSlot()) {
      const ship = this.h.getActiveShip(pid);
      if (!ship?.alive || !ship.isActive || pid === rec.owner) continue;
      const sb = slotBase(slot);
      if (!onPad(rec.kind, rec.x, rec.y, sabF32[sb + SLOT_X_OFF]!, sabF32[sb + SLOT_Y_OFF]!)) continue;
      const rel = relationOf(pid, rec.owner, this.h.relationCtx);
      if (rel === 'self' || rel === 'friendly' || rel === 'allied') continue;
      const pref = sink?.tollPref?.(pid, ownerFaction);
      if (pref === 'always') { answers.set(pid, this.payToll(rec, pid, credits) ? 'paid' : 'declined'); continue; }
      if (pref === 'never') { answers.set(pid, 'declined'); continue; }
      answers.set(pid, 'pending');
      if (padId >= 0) this.h.sendToPlayerHere(pid, 'teleport_toll', { type: 'teleport_toll', padId, credits, ownerName } satisfies TollPrompt);
    }
    serverLogEvent('teleport_toll_offered', { sectorKey: this.h.sectorKey() ?? '', padId, riders: answers.size });
  }

  /** Take the toll from the rider's wallet (all or nothing) and pay the owner:
   *  a player's wallet, or an NPC faction's treasury. */
  private payToll(rec: StructureRecord, pid: string, credits: number): boolean {
    if (!getWallet().debit(pid, credits, 'teleport_toll')) return false;
    const owner = parseOwner(rec.owner);
    if (owner.kind === 'player') getWallet().credit(rec.owner, credits, 'teleport_toll');
    else getTradeSink()?.creditFaction?.(owner.faction, credits);
    return true;
  }

  /** The swap is now: anyone still on the pad who was asked and didn't pay
   *  rides anyway, and loses the owner's standing (or becomes hostile). */
  settleToll(rec: StructureRecord): void {
    const entry = this.tollAnswers.get(rec.id);
    this.tollAnswers.delete(rec.id);
    if (!entry || !isTeleporterKind(rec.kind)) return;
    const hostile = rec.tpToll?.nonPayer === 'hostile';
    const ownerFaction = parseOwner(rec.owner).faction;
    const sabF32 = this.h.sabF32();
    for (const [pid, state] of entry.answers) {
      if (state === 'paid') continue;
      const slot = this.h.playerToSlot().get(pid);
      if (slot === undefined) continue;
      const sb = slotBase(slot);
      if (!onPad(rec.kind, rec.x, rec.y, sabF32[sb + SLOT_X_OFF]!, sabF32[sb + SLOT_Y_OFF]!)) continue;
      if (hostile) this.h.hostileActs.record(pid, rec.owner, this.h.now());
      else this.h.adjustStanding(ownerFaction, pid, TOLL_DODGE_STANDING);
      serverLogEvent('teleport_toll_dodged', { sectorKey: this.h.sectorKey() ?? '', playerId: pid, owner: rec.owner, hostile });
    }
  }

  /** A rider answered a toll prompt. */
  answerToll(pid: string, padId: number, answer: TollAnswer): void {
    const sw = this.h.swarmRegistry.getByEntityId(padId);
    const rec = sw ? this.h.structureRegistry.get(sw.id) : undefined;
    const entry = rec ? this.tollAnswers.get(rec.id) : undefined;
    // Too late (the swap already settled it) or not asked: log, ignore.
    if (!rec || !entry || entry.answers.get(pid) !== 'pending') {
      serverLogEvent('teleport_toll_answer_ignored', { sectorKey: this.h.sectorKey() ?? '', playerId: pid, padId, hasRec: rec !== undefined, hasEntry: entry !== undefined, state: entry?.answers.get(pid) ?? null });
      return;
    }
    const ownerFaction = parseOwner(rec.owner).faction;
    if (answer === 'always' || answer === 'never') getTradeSink()?.setTollPref?.(pid, ownerFaction, answer);
    const pay = answer === 'pay' || answer === 'always';
    entry.answers.set(pid, pay && this.payToll(rec, pid, entry.credits) ? 'paid' : 'declined');
  }
}
