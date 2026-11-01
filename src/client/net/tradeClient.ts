/**
 * Trade message senders (Living World P2b). The verdict comes back as a
 * `trade_notice` toast; the Trade tab then refetches `GET /trade/economy`.
 * Each returns true when sent (false when there's no live room).
 */
import { getGameClient } from './clientSingleton.js';
import type { EconAllegiance } from '../../shared-types/economy.js';
import type { GoodId } from '../../shared-types/goods.js';
import type { LabStart } from '../../shared-types/messages/labMessages.js';

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

/** P5 — install a stored blueprint onto my active ship (verdict: `blueprint_result`). */
export function sendInstallBlueprint(networkEntityId: number, blueprintId: string): boolean {
  return send('install_blueprint', { networkEntityId, blueprintId });
}

/** Economy v2 W3 — Research Lab requests (each answered by `lab_state`). */
export function sendLabQuery(entityId: number): boolean {
  return send('lab_query', { entityId });
}

export function sendLabStart(entityId: number, job: LabStart['job']): boolean {
  return send('lab_start', { entityId, job });
}

export function sendLabCancel(entityId: number): boolean {
  return send('lab_cancel', { entityId });
}

/** P4c-2 — put a bounty on a player (verdict: `bounty_result`). */
export function sendPlaceBounty(args: { targetPlayerId: string; amount: number }): boolean {
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
