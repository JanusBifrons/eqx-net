/**
 * Trade HTTP reads (Living World P2b). zod-validated (invariant #3): a
 * malformed or failed response yields null, never a crash or a fabricated view.
 */
import {
  PlayerEconomyViewSchema,
  TradeOffersResponseSchema,
  type PlayerEconomyView,
  type TradeOffer,
} from '../../shared-types/economy.js';

export async function fetchEconomy(playerId: string): Promise<PlayerEconomyView | null> {
  try {
    const res = await fetch(`/trade/economy?playerId=${encodeURIComponent(playerId)}`);
    if (!res.ok) return null;
    const parsed = PlayerEconomyViewSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** T3 — prices are regional: pass the sector the player trades from. */
export async function fetchOffers(playerId: string, sectorKey?: string | null): Promise<TradeOffer[] | null> {
  try {
    const sector = sectorKey ? `&sector=${encodeURIComponent(sectorKey)}` : '';
    const res = await fetch(`/trade/offers?playerId=${encodeURIComponent(playerId)}${sector}`);
    if (!res.ok) return null;
    const parsed = TradeOffersResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.offers : null;
  } catch {
    return null;
  }
}

/** localStorage key for the "while you were away" watermark. */
export const TRADE_LAST_SEEN_KEY = 'eqxTradeLastSeenMs';

export function loadTradeLastSeen(): number {
  try {
    const v = Number(localStorage.getItem(TRADE_LAST_SEEN_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export function saveTradeLastSeen(ms: number): void {
  try {
    localStorage.setItem(TRADE_LAST_SEEN_KEY, String(ms));
  } catch { /* storage blocked — the summary just shows again */ }
}
