/**
 * Teleporter client messages — pair, unpair, fire, rules, tolls, pad
 * load/unload and cross-sector pair requests (v4 T1-T4). Moved verbatim out
 * of `SectorRoom.onCreate`; the room hands in live accessors so every handler
 * reads the same state it did when it lived there.
 */
import type { Client } from 'colyseus';
import { randomUUID } from 'node:crypto';
import type { StructureRecord, StructureRegistry } from '../structures/StructureRegistry.js';
import type { TeleporterSubsystem } from '../structures/TeleporterSubsystem.js';
import { getTeleportBroker, type TeleportRoom } from '../teleport/TeleportBroker.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { MalformedMessageTracker } from './MalformedMessageTracker.js';
import type { StorageService } from '../cargo/StorageService.js';
import { getSector } from '../../core/galaxy/galaxy.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { isNpcOwner, relationOf, type RelationContext } from '../../shared-types/relations.js';
import {
  isFreeTeleporterKind,
  isTeleporterKind,
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
  type TollAnswer,
} from '../../shared-types/teleport.js';

/** What the handlers need from the room; getters read the live field. */
export interface TeleportMessageHost {
  onMessage(type: string, handler: (client: Client, raw: unknown) => void): void;
  malformed: Pick<MalformedMessageTracker, 'record'>;
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

export function registerTeleportMessages(h: TeleportMessageHost): void {
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
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
    act: (rec: StructureRecord, msg: T, client: Client) => void,
  ) => (client: Client, raw: unknown): void => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      h.malformed.record(client.sessionId, type);
      return;
    }
    const rec = ownTeleporter(client, parsed.data.entityId);
    if (rec) act(rec, parsed.data, client);
  };
  h.onMessage('teleport_pair', tpMessage('teleport_pair', TeleportPairSchema, (rec, msg, client) => {
    const other = ownTeleporter(client, msg.partnerEntityId);
    if (other) h.teleporters().pair(rec, other);
  }));
  // T3 — the sender's other teleporters, here and in every other sector.
  // Any teleporter (yours or someone else's, for a pair request): it lists
  // the SENDER's own teleporters.
  h.onMessage('teleport_candidates', (client: Client, raw: unknown) => {
    const parsed = TeleportCandidatesQuerySchema.safeParse(raw);
    if (!parsed.success) {
      h.malformed.record(client.sessionId, 'teleport_candidates');
      return;
    }
    const msg = parsed.data;
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
  h.onMessage('set_teleport_toll', tpMessage('set_teleport_toll', SetTeleportTollSchema, (rec, msg) => {
    if (msg.toll === null || msg.toll.per1000 === 0) delete rec.tpToll;
    else rec.tpToll = { ...msg.toll };
    h.rebuildStructuresSlice();
  }));
  h.onMessage('teleport_toll_answer', (client: Client, raw: unknown) => {
    const parsed = TollAnswerSchema.safeParse(raw);
    if (!parsed.success) {
      h.malformed.record(client.sessionId, 'teleport_toll_answer');
      return;
    }
    const pid = h.sessionToPlayer().get(client.sessionId);
    if (pid) h.answerToll(pid, parsed.data.padId, parsed.data.answer);
  });
  // T4 — ask another owner to pair their teleporter (here) with one of yours.
  h.onMessage('teleport_pair_request', (client: Client, raw: unknown) => {
    const parsed = TeleportPairRequestSchema.safeParse(raw);
    if (!parsed.success) {
      h.malformed.record(client.sessionId, 'teleport_pair_request');
      return;
    }
    const pid = h.sessionToPlayer().get(client.sessionId);
    const sw = h.swarmRegistry.getByEntityId(parsed.data.entityId);
    const target = sw ? h.structureRegistry.get(sw.id) : undefined;
    if (!pid || !target || !isTeleporterKind(target.kind) || !target.isConstructed || target.owner === pid || target.uid === undefined) return;
    // v4 A — alien gates only ever link to each other; v4 H — an NPC
    // teleporter is pre-linked by the transit network.
    if (isFreeTeleporterKind(target.kind) || isNpcOwner(target.owner)) return;
    if (relationOf(pid, target.owner, h.relationCtx) === 'hostile') return;
    const here = h.sectorKey() ?? '';
    const mine = parsed.data.sectorKey === here
      ? h.teleporters().byUid(parsed.data.uid)
      : getTeleportBroker().find(parsed.data.sectorKey, parsed.data.uid)?.rec ?? null;
    if (!mine || mine.owner !== pid || !mine.isConstructed) return;
    const id = randomUUID();
    getTeleportBroker().addRequest({
      id, targetSector: here, targetUid: target.uid, toOwner: target.owner,
      fromSector: parsed.data.sectorKey, fromUid: parsed.data.uid, fromOwner: pid, atMs: h.now(),
    });
    const fromName = h.resolveOwnerName(pid) ?? 'A pilot';
    const where = (sk: string): string => (sk === here ? 'here' : (getSector(sk)?.name ?? 'another sector'));
    const label = `their ${getStructureKind(mine.kind).displayName} (${where(parsed.data.sectorKey)}) with your ${getStructureKind(target.kind).displayName} (${getSector(here)?.name ?? 'this sector'})`;
    getTeleportBroker().sendToPlayer(target.owner, 'teleport_pair_request', { type: 'teleport_pair_request', requestId: id, fromName, label } satisfies PairRequestPrompt);
  });
  h.onMessage('teleport_pair_answer', (client: Client, raw: unknown) => {
    const parsed = TeleportPairAnswerSchema.safeParse(raw);
    if (!parsed.success) {
      h.malformed.record(client.sessionId, 'teleport_pair_answer');
      return;
    }
    const pid = h.sessionToPlayer().get(client.sessionId);
    const broker = getTeleportBroker();
    const req = broker.takeRequest(parsed.data.requestId, h.now());
    if (!pid || !req || req.toOwner !== pid || !parsed.data.accept) return;
    const target = broker.find(req.targetSector, req.targetUid);
    const from = broker.find(req.fromSector, req.fromUid);
    if (!target || !from || target.rec.owner !== pid || from.rec.owner !== req.fromOwner) return;
    target.room.teleporters.pair(target.rec, from.rec, from.room.teleporters, true);
  });

  h.onMessage('teleport_pair_remote', tpMessage('teleport_pair_remote', TeleportPairRemoteSchema, (rec, msg) => {
    if (msg.sectorKey === (h.sectorKey() ?? '')) {
      const other = h.teleporters().byUid(msg.uid);
      if (other && other.isConstructed) h.teleporters().pair(rec, other);
      return;
    }
    const f = getTeleportBroker().find(msg.sectorKey, msg.uid);
    if (f && f.rec.owner === rec.owner) h.teleporters().pair(rec, f.rec, f.room.teleporters);
  }));
  h.onMessage('teleport_unpair', tpMessage('teleport_unpair', TeleportUnpairSchema, (rec) => h.teleporters().unpair(rec)));
  h.onMessage('teleport_fire', tpMessage('teleport_fire', TeleportFireSchema, (rec) => { h.teleporters().fire(rec, h.now()); }));
  h.onMessage('set_teleport_rules', tpMessage('set_teleport_rules', SetTeleportRulesSchema, (rec, msg) => h.teleporters().setRules(rec, msg.rules)));
  h.onMessage('teleport_pad_load', tpMessage('teleport_pad_load', TeleportPadLoadSchema, (rec, msg) => {
    if (!isTeleporterKind(rec.kind) || !rec.isConstructed) return;
    h.storage().padLoad(rec, msg.good, msg.qty, PAD_SPECS[rec.kind].padCapacity);
    h.rebuildStructuresSlice();
  }));
  h.onMessage('teleport_pad_unload', tpMessage('teleport_pad_unload', TeleportPadUnloadSchema, (rec) => {
    h.storage().padUnload(rec);
    h.rebuildStructuresSlice();
  }));
}
