/**
 * Trade message senders (Living World P2b). The verdict comes back as a
 * `trade_notice` toast; the Trade tab then refetches `GET /trade/economy`.
 * Each returns true when sent (false when there's no live room).
 */
import { getGameClient } from './clientSingleton.js';
import type { EconAllegiance } from '../../shared-types/economy.js';
import type { GoodId } from '../../shared-types/goods.js';
import type { LabStart } from '../../shared-types/messages/labMessages.js';
import type { CargoItems, FreightOrder } from '../../shared-types/messages/cargoMessages.js';

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

/** C1 — open a structure's cargo / move items (each answered by `cargo_state`). */
export function sendCargoQuery(entityId: number): boolean {
  return send('cargo_query', { entityId });
}

export function sendCargoMove(entityId: number, dir: 'take' | 'put', items: CargoItems): boolean {
  return send('cargo_move', { entityId, dir, items });
}

/** C2 — break into locked cargo (a hostile act) / stop. */
export function sendBreakIn(entityId: number): boolean {
  return send('break_in', { entityId });
}

export function sendBreakInCancel(): boolean {
  return send('break_in_cancel', {});
}

/** T4b — replace my Freight Dock's standing orders (re-read via `cargo_state`). */
export function sendSetFreightOrders(entityId: number, orders: FreightOrder[]): boolean {
  return send('set_freight_orders', { entityId, orders });
}

/** Economy v2 W6 — the blueprint market (each answered by `bp_market_state`). */
export function sendBpMarketQuery(networkEntityId: number): boolean {
  return send('bp_market_query', { networkEntityId });
}

export function sendBpBuy(networkEntityId: number, offerId: string): boolean {
  return send('bp_buy', { networkEntityId, offerId });
}

export function sendBpSell(networkEntityId: number, uid: string): boolean {
  return send('bp_sell', { networkEntityId, uid });
}

/** Economy v2 W5a — unpack a packed hull at my storage into my roster
 *  (verdict: `blueprint_result`). */
export function sendUnpackHull(networkEntityId: number, kind: string): boolean {
  return send('unpack_hull', { networkEntityId, kind });
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
