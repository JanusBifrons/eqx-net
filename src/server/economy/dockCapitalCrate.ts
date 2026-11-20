/**
 * Playable base loop — an NPC Freight Dock sells a Capital crate to a docked
 * pilot, so a pilot with NO base (nowhere for a board hauler to deliver) can
 * still buy one. The price is the trade board's (`capitalCratePrice`, the
 * same `quotePacked` of the crate's minerals); the crate is the board's fresh
 * one (`traderPackedItem`: own uid, full bank). Ship hold + wallet debit land
 * in ONE atomic group, like the dock's goods buys (`StorageService.marketBuy`).
 */
import { cloneHold, emptyHold, holdWeight, packedItemWeight } from '../../core/cargo/hold.js';
import type { Hold } from '../../shared-types/goods.js';
import type { HoldStore } from '../cargo/HoldStore.js';
import type { Wallet } from './Wallet.js';
import { CAPITAL_CRATE_PRODUCT, capitalCratePrice, traderPackedItem } from './capitalCrateTrade.js';
import { TRADER_PACKED_QUALITY } from './TradeDirector.js';

/** The dock's always-on crate listing (shown in its "For sale" stock). */
export const DOCK_CAPITAL_LISTING = { product: CAPITAL_CRATE_PRODUCT, quality: TRADER_PACKED_QUALITY } as const;

export const DOCK_CRATE_NO_CREDITS = 'Not enough credits for a Capital crate.';
export const DOCK_CRATE_NO_ROOM = 'No room aboard for a Capital crate.';
export const DOCK_CRATE_VOLUME = 'Hourly trade limit reached.';

export interface DockCrateBuy {
  holds: Pick<HoldStore, 'get' | 'commit'>;
  wallet: Pick<Wallet, 'balance' | 'debitDeferred'>;
  persist: boolean;
  playerId: string;
  shipInstanceId: string;
  shipCapacity: number;
  /** The pilot's standing with traders (prices the crate). */
  traderRep: number;
  /** The pilot's remaining hourly trade volume (credits of value). */
  volumeLeft: number;
}

/** Buy one fresh Capital crate into the pilot's ship hold. Refuses (nothing
 *  changes) when credits, hold room or trade volume are short. */
export function buyCapitalCrateAtDock(d: DockCrateBuy): { ok: true; cost: number } | { ok: false; message: string } {
  const cost = Math.ceil(capitalCratePrice(d.traderRep));
  const ship: Hold = cloneHold(d.holds.get(d.shipInstanceId)?.hold ?? emptyHold());
  const item = traderPackedItem(CAPITAL_CRATE_PRODUCT, TRADER_PACKED_QUALITY);
  if (holdWeight(ship) + packedItemWeight(item) > d.shipCapacity) return { ok: false, message: DOCK_CRATE_NO_ROOM };
  if (d.wallet.balance(d.playerId) < cost) return { ok: false, message: DOCK_CRATE_NO_CREDITS };
  if (cost > d.volumeLeft) return { ok: false, message: DOCK_CRATE_VOLUME };
  const op = cost > 0 ? d.wallet.debitDeferred(d.playerId, cost, 'dock_buy') : null;
  if (cost > 0 && op === null) return { ok: false, message: DOCK_CRATE_NO_CREDITS };
  (ship.packed ??= []).push(item);
  d.holds.commit(
    [{ holderUid: d.shipInstanceId, holderType: 'ship', ownerId: d.playerId, sectorKey: null, x: null, y: null, hold: ship, expiresAt: null }],
    [], d.persist, op ? [op] : [],
  );
  return { ok: true, cost };
}
