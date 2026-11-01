/**
 * Room → TradeDirector back-channel (plan peppy-jumping-pinwheel P2). A
 * cycle-safe singleton (the `incomingPlayerSink` pattern): rooms forward trade
 * messages and economy-relevant combat events here; null when the economy is
 * not running (tests, kill switch) ⇒ every call site is a no-op.
 */
import type { z } from 'zod';
import type { AcceptOfferSchema, SendGiftSchema } from '../../shared-types/economy.js';
import type { GoodId } from '../../shared-types/goods.js';
import type { TradeRoom } from './TradeDirector.js';

export type AcceptOfferMsg = z.infer<typeof AcceptOfferSchema>;
export type SendGiftMsg = z.infer<typeof SendGiftSchema>;

/** A request's immediate verdict (the room relays it as a `trade_notice`). */
export interface TradeVerdict {
  ok: boolean;
  dealId: string | null;
  message: string;
}

export interface TradeSink {
  /** `networkUid` is resolved by the room from the message's storage entityId
   *  (owner-checked there). */
  acceptOffer(playerId: string, sectorKey: string, networkUid: string, msg: AcceptOfferMsg): TradeVerdict;
  cancelDeal(playerId: string, dealId: string): TradeVerdict;
  sendGift(playerId: string, sectorKey: string, networkUid: string, msg: SendGiftMsg): TradeVerdict;
  /** A trade hauler took a hit. `attackerPlayerId` is the player responsible
   *  (directly or via their structures), or null for an NPC attacker. */
  onHaulerDamaged(haulerId: string, attackerPlayerId: string | null): void;
  /** A player damaged a robot — standing drops (ends any truce). Throttled inside. */
  onRobotDamaged(attackerPlayerId: string): void;
  /** Robot reputation ≥ ROBOT_TRUCE_AT. Hot-path safe (one Map lookup). */
  robotTruce(playerId: string): boolean;
  /** Drone-reputation wave spacing multiplier (≥ 1). */
  waveIntervalFactor(playerId: string): number;
  /** T4 — what an NPC Freight Dock charges (`buy`) and pays (`sell`) this
   *  pilot per unit of `good` in `sectorKey`'s region; null when traders
   *  refuse to deal with them. The same quote as the trade board. */
  dockQuote(playerId: string, sectorKey: string | null, good: GoodId): { buy: number; sell: number } | null;
  /** T4 — the pilot's remaining hourly trade volume (credits of value). */
  volumeLeft(playerId: string): number;
  /** T4 — a settled dock trade moves the market and counts toward volume. */
  recordDockFill(playerId: string, good: GoodId, qty: number, side: 'buy' | 'sell', value: number): void;
  /** testMode rooms that opt into trade (showcase / E2E) join at onCreate. */
  registerRoom(sectorKey: string, room: TradeRoom): void;
  unregisterRoom(sectorKey: string, room: TradeRoom): void;
}

let _sink: TradeSink | null = null;

export function setTradeSink(sink: TradeSink | null): void {
  _sink = sink;
}

export function getTradeSink(): TradeSink | null {
  return _sink;
}
