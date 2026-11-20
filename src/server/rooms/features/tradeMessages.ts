/**
 * Trade and faction-standing client messages — faction policy, a faction
 * look claim, and the Living World P2 trade deals (accept an offer, cancel a
 * deal, send a gift). Moved verbatim out of `SectorRoom.onCreate`; the room
 * hands in live accessors so every handler reads the same state it did there.
 * Also the P3c harvester storage raid (`StorageRaid`, moved verbatim out of
 * `SectorRoom.raidStorage`): the room side of a trade transfer + notice.
 */
import type { Client } from 'colyseus';
import type { StructureRegistry } from '../../structures/StructureRegistry.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { StorageService, TradeTransferResult, TradeTransferSpec } from '../../cargo/StorageService.js';
import { getTradeSink } from '../../economy/tradeSink.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import { RAID_NOTICE_THROTTLE_MS, RAID_PRIORITY } from '../../livingworld/RobotTerritory.js';
import { emptyHold, holdWeight, isHoldEmpty } from '../../../core/cargo/hold.js';
import { GOOD_DEFS } from '../../../shared-types/goods.js';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';
import { AcceptOfferSchema, CancelDealSchema, SendGiftSchema, type TradeNotice } from '../../../shared-types/economy.js';
import { ClaimFactionLookSchema, SetFactionPolicySchema, claimFactionLookResult } from '../../../shared-types/messages/factionMessages.js';

/** What the handlers need from the room; getters read the live field. */
export interface TradeMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  sectorKey(): string | null;
  /** The key the TradeDirector knows this room by (null ⇒ not a testMode trade room). */
  tradeRegisteredKey(): string | null;
  ensureTradeRegistered(): void;
}

export function registerTradeMessages(h: TradeMessageHost): RoomFeature {
  // F3 — a player edits their own faction's policy (owner = the session).
  parsedMessage(h, 'set_faction_policy', SetFactionPolicySchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    getTradeSink()?.setPlayerPolicy?.(owner, msg.policy);
  });

  // A player claims a unique ship look for their faction; the claimant gets
  // the verdict, every room gets a success (`broadcastFactionLook`).
  parsedMessage(h, 'claim_faction_look', ClaimFactionLookSchema, (msg, client) => {
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    const claim = getTradeSink()?.claimFactionLook?.(owner, msg.colorSlot, msg.sigil);
    if (claim) try { client.send('claim_faction_look_result', claimFactionLookResult(claim)); } catch { /* closing */ }
  });

  // ── Living World P2 — trade deals (account required) ───────────────────
  // Thin relays to the process-global TradeDirector (via the trade sink).
  // The verdict comes straight back as a `trade_notice` (accelerator only —
  // the Trade tab's truth is `GET /player/economy`, #16).
  const tradeRequest = (
    client: Client,
    kind: 'accept_offer' | 'cancel_deal' | 'send_gift',
    raw: unknown,
  ): void => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    const sink = getTradeSink();
    if (!playerId || !sink) return;
    // A testMode trade room may have been created before boot installed the
    // director — join it now (idempotent).
    h.ensureTradeRegistered();
    const reply = (ok: boolean, dealId: string | null, message: string): void => {
      try {
        client.send('trade_notice', {
          type: 'trade_notice', dealId: dealId ?? '', event: ok ? 'accepted' : 'rejected', message, econVersion: 0,
        } satisfies TradeNotice);
      } catch { /* socket closing */ }
    };
    // The key the TradeDirector knows this room by (galaxy: the sectorKey).
    const tradeKey = h.tradeRegisteredKey() ?? h.sectorKey();
    if (tradeKey === null) { reply(false, null, 'Trade is only available in the galaxy.'); return; }
    // Economy v2 — guests are full players (the user's ruling): no sign-in gate.
    // A storage structure the player OWNS here → its stable uid.
    const networkUidOf = (entityId: number): string | null => {
      const rec = h.swarmRegistry.getByEntityId(entityId);
      const s = rec ? h.structureRegistry.get(rec.id) : undefined;
      return s !== undefined && s.owner === playerId && s.uid !== undefined ? s.uid : null;
    };
    let v;
    if (kind === 'accept_offer') {
      const p = AcceptOfferSchema.safeParse(raw);
      if (!p.success) { h.malformed.record(client.sessionId, kind); return; }
      const uid = networkUidOf(p.data.networkEntityId);
      if (uid === null) { reply(false, null, 'Pick one of your storage structures.'); return; }
      v = sink.acceptOffer(playerId, tradeKey, uid, p.data);
    } else if (kind === 'cancel_deal') {
      const p = CancelDealSchema.safeParse(raw);
      if (!p.success) { h.malformed.record(client.sessionId, kind); return; }
      v = sink.cancelDeal(playerId, p.data.dealId);
    } else {
      const p = SendGiftSchema.safeParse(raw);
      if (!p.success) { h.malformed.record(client.sessionId, kind); return; }
      const uid = networkUidOf(p.data.networkEntityId);
      if (uid === null) { reply(false, null, 'Pick one of your storage structures.'); return; }
      v = sink.sendGift(playerId, tradeKey, uid, p.data);
    }
    reply(v.ok, v.dealId, v.message);
  };
  h.onMessage('accept_offer', (client: Client, raw: unknown) => tradeRequest(client, 'accept_offer', raw));
  h.onMessage('cancel_deal', (client: Client, raw: unknown) => tradeRequest(client, 'cancel_deal', raw));
  h.onMessage('send_gift', (client: Client, raw: unknown) => tradeRequest(client, 'send_gift', raw));
  return {};
}

/** What the storage raid needs from the room; getters read the live field. */
export interface StorageRaidHost {
  storage(): Pick<StorageService, 'tradeSnapshot'>;
  sectorKey(): string | null;
  now(): number;
  tradeTransfer(ownerId: string, networkUid: string, spec: TradeTransferSpec): TradeTransferResult | null;
  tradeNotify(playerId: string, notice: TradeNotice): void;
}

/** P3c — robot harvesters raid a player's storage network. */
export class StorageRaid {
  /** P3c — last raid warning per owner (throttle). */
  private readonly raidNoticeAtMs = new Map<string, number>();

  constructor(private readonly h: StorageRaidHost) {}

  /** P3c — a harvester steals up to `stepWeight` (rarest goods first, plus up
   *  credits — never: they're virtual) from the storage network at `uid`, as
   *  ONE atomic `tradeTransfer` group into its own ownerless hold. */
  raid(harvesterId: string, owner: string, uid: string, stepWeight: number): number {
    const snap = this.h.storage().tradeSnapshot(owner, uid);
    if (snap === null || stepWeight <= 0) return 0;
    const want = emptyHold();
    let room = stepWeight;
    for (const g of RAID_PRIORITY) {
      const w = GOOD_DEFS[g].weight;
      const n = Math.min(snap.goods[g] ?? 0, Math.floor(room / w));
      if (n <= 0) continue;
      want.goods[g] = n;
      room -= n * w;
    }
    if (isHoldEmpty(want)) return 0;
    const res = this.h.tradeTransfer(owner, uid, { take: { want, intoUid: harvesterId, intoOwner: null } });
    if (res === null || isHoldEmpty(res.taken)) return 0;
    const weight = holdWeight(res.taken);
    auditEvent({ event: 'storage_raided', sector: this.h.sectorKey() ?? undefined, playerId: owner, raider: harvesterId, weight });
    const now = this.h.now();
    if (now - (this.raidNoticeAtMs.get(owner) ?? 0) >= RAID_NOTICE_THROTTLE_MS) {
      this.raidNoticeAtMs.set(owner, now);
      this.h.tradeNotify(owner, {
        type: 'trade_notice', dealId: '', event: 'raided',
        message: 'Robot harvesters are raiding your storage! Defend your base.', econVersion: 0,
      });
    }
    return weight;
  }
}
