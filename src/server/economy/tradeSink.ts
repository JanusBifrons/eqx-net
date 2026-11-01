/**
 * Room → TradeDirector back-channel (plan peppy-jumping-pinwheel P2). A
 * cycle-safe singleton (the `incomingPlayerSink` pattern): rooms forward trade
 * messages and economy-relevant combat events here; null when the economy is
 * not running (tests, kill switch) ⇒ every call site is a no-op.
 */
import type { z } from 'zod';
import type { AcceptOfferSchema, SendGiftSchema } from '../../shared-types/economy.js';

export type AcceptOfferMsg = z.infer<typeof AcceptOfferSchema>;
export type SendGiftMsg = z.infer<typeof SendGiftSchema>;

/** A request's immediate verdict (the room relays it as a `trade_notice`). */
export interface TradeVerdict {
  ok: boolean;
  dealId: string | null;
  message: string;
}

export interface TradeSink {
  acceptOffer(playerId: string, sectorKey: string, msg: AcceptOfferMsg): TradeVerdict;
  cancelDeal(playerId: string, dealId: string): TradeVerdict;
  sendGift(playerId: string, sectorKey: string, msg: SendGiftMsg): TradeVerdict;
  /** A player (directly or via their structures) damaged a trade hauler. */
  onHaulerDamaged(haulerId: string, attackerPlayerId: string): void;
  /** A player damaged a robot — standing drops (ends any truce). Throttled inside. */
  onRobotDamaged(attackerPlayerId: string): void;
  /** Robot reputation ≥ ROBOT_TRUCE_AT. Hot-path safe (one Map lookup). */
  robotTruce(playerId: string): boolean;
  /** Drone-reputation wave spacing multiplier (≥ 1). */
  waveIntervalFactor(playerId: string): number;
}

let _sink: TradeSink | null = null;

export function setTradeSink(sink: TradeSink | null): void {
  _sink = sink;
}

export function getTradeSink(): TradeSink | null {
  return _sink;
}
