/**
 * Trade message senders (Living World P2b). The verdict comes back as a
 * `trade_notice` toast; the Trade tab then refetches `GET /trade/economy`.
 * Each returns true when sent (false when there's no live room).
 */
import { getGameClient } from './clientSingleton.js';
import type { EconAllegiance } from '../../shared-types/economy.js';
import type { GoodId } from '../../shared-types/goods.js';

function send(type: string, payload: Record<string, unknown>): boolean {
  const room = getGameClient()?.getRoom();
  if (!room) return false;
  room.send(type, { type, ...payload });
  return true;
}

export function sendAcceptOffer(args: {
  offerId: string;
  networkEntityId: number;
  qty: number;
  recurrenceMin: 10 | 30 | 60 | null;
  visits: number | null;
  priceBandPct: number;
}): boolean {
  return send('accept_offer', args);
}

export function sendCancelDeal(dealId: string): boolean {
  return send('cancel_deal', { dealId });
}

/** P4c-2 — put a bounty on a player (verdict: `bounty_result`). */
export function sendPlaceBounty(args: { targetPlayerId: string; networkEntityId: number; amount: number }): boolean {
  return send('place_bounty', args);
}

export function sendGift(args: {
  allegiance: EconAllegiance;
  networkEntityId: number;
  good: GoodId | null;
  qty: number;
  credits: number;
}): boolean {
  return send('send_gift', args);
}
