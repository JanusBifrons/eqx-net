/**
 * Trade-deal decisions (plan peppy-jumping-pinwheel P2). Pure, zone-blind.
 *
 * A deal is a standing agreement; each VISIT is one hauler run:
 *   scheduled → inbound (hauler flying in) → docked (both sides in escrow)
 *     → departing (spooling out) → settled, and back to scheduled if recurring.
 * A visit is SKIPPED (and retried) when the base has no storage, is under
 * attack, traders refuse the player, or a recurring re-quote leaves the
 * player's price band. A shortfall fills PARTIALLY (small rep hit).
 *
 * The server's `TradeDirector` owns the records and the side effects; every
 * decision about quantities, prices and next states is made here.
 */
import { GOOD_DEFS, type GoodId } from '../../shared-types/goods.js';
import {
  HAULING_FEE,
  type DealKind,
  type DealState,
  type EconAllegiance,
} from '../../shared-types/economy.js';
import { tradersRefuse } from './reputation.js';

/** One-off deals retry a skipped visit this often, up to `ONE_OFF_MAX_ATTEMPTS`. */
export const ONE_OFF_RETRY_MS = 5 * 60 * 1000;
export const ONE_OFF_MAX_ATTEMPTS = 6;

export interface TradeRun {
  runId: string;
  /** Swarm entity id of the hauler (also its cargo hold's holder uid). */
  haulerId: string;
  phase: 'inbound' | 'docked' | 'departing';
  qty: number;
  credits: number;
  unitPrice: number;
  partial: boolean;
  phaseStartedAtMs: number;
  /** Players who damaged the hauler during this run (piracy / self-raid). */
  attackers: string[];
  dockX: number;
  dockY: number;
}

export interface TradeDeal {
  dealId: string;
  ownerId: string;
  kind: DealKind;
  /** Traders for sell/buy; the gift's recipient side for gifts. */
  allegiance: EconAllegiance;
  good: GoodId | null;
  qty: number;
  /** Gift only: credits carried. */
  credits: number;
  sectorKey: string;
  networkUid: string;
  /** The price accepted (per unit). Recurring visits re-quote within the band. */
  unitPrice: number;
  priceBandPct: number;
  recurrenceMin: number | null;
  /** Recurring: visits remaining (null ⇒ until cancelled). One-off: 1. */
  visitsLeft: number | null;
  state: DealState;
  nextVisitAtMs: number | null;
  createdAtMs: number;
  /** Skipped attempts in a row (one-off retry budget). */
  attempts: number;
  run: TradeRun | null;
}

/** What the base network can offer a visit right now. */
export interface NetworkSnapshot {
  exists: boolean;
  underAttack: boolean;
  goods: Partial<Record<GoodId, number>>;
  credits: number;
  /** Free weight capacity across the network (for buys). */
  freeCapacity: number;
}

export type SkipReason = 'no-storage' | 'under-attack' | 'refused' | 'out-of-band' | 'nothing-to-trade';

export type VisitPlan =
  | { go: true; qty: number; credits: number; unitPrice: number; partial: boolean }
  | { go: false; reason: SkipReason };

/** Credits a SELL of `qty` at `unit` pays out, after the hauling fee. */
export function sellProceeds(qty: number, unit: number): number {
  return Math.max(0, Math.floor(qty * unit) - HAULING_FEE);
}

/** Credits a BUY of `qty` at `unit` costs, including the hauling fee. */
export function buyCost(qty: number, unit: number): number {
  return Math.ceil(qty * unit) + HAULING_FEE;
}

/**
 * Decide one visit. `quoteNow` is the live price for this deal's side at the
 * player's current trader rep; one-off deals honour the accepted price, while
 * recurring deals re-quote and skip when the move exceeds the player's band.
 */
export function planVisit(deal: TradeDeal, net: NetworkSnapshot, quoteNow: number, traderRep: number): VisitPlan {
  if (!net.exists) return { go: false, reason: 'no-storage' };
  if (net.underAttack) return { go: false, reason: 'under-attack' };
  if (deal.kind !== 'gift' && tradersRefuse(traderRep)) return { go: false, reason: 'refused' };

  let unit = deal.unitPrice;
  if (deal.kind !== 'gift' && deal.recurrenceMin !== null) {
    const movePct = deal.unitPrice > 0 ? (Math.abs(quoteNow - deal.unitPrice) / deal.unitPrice) * 100 : 0;
    if (movePct > deal.priceBandPct) return { go: false, reason: 'out-of-band' };
    unit = quoteNow;
  }

  if (deal.kind === 'sell') {
    const have = deal.good ? net.goods[deal.good] ?? 0 : 0;
    const qty = Math.min(deal.qty, have);
    if (qty <= 0) return { go: false, reason: 'nothing-to-trade' };
    return { go: true, qty, credits: 0, unitPrice: unit, partial: qty < deal.qty };
  }

  if (deal.kind === 'buy') {
    if (!deal.good) return { go: false, reason: 'nothing-to-trade' };
    const w = GOOD_DEFS[deal.good].weight;
    const fit = w > 0 ? Math.floor((net.freeCapacity + 1e-9) / w) : deal.qty;
    // Largest qty the network can pay for, fee included.
    let afford = Math.floor(Math.max(0, net.credits - HAULING_FEE) / Math.max(0.01, unit));
    while (afford > 0 && buyCost(afford, unit) > net.credits) afford--;
    const qty = Math.min(deal.qty, fit, afford);
    if (qty <= 0) return { go: false, reason: 'nothing-to-trade' };
    return { go: true, qty, credits: 0, unitPrice: unit, partial: qty < deal.qty };
  }

  // Gift: carry what is available, up to the pledge.
  const goodsQty = deal.good ? Math.min(deal.qty, net.goods[deal.good] ?? 0) : 0;
  const credits = Math.min(deal.credits, net.credits);
  if (goodsQty <= 0 && credits <= 0) return { go: false, reason: 'nothing-to-trade' };
  const partial = goodsQty < (deal.good ? deal.qty : 0) || credits < deal.credits;
  return { go: true, qty: goodsQty, credits, unitPrice: 0, partial };
}

/** Credit value of a visit (gift reputation + the hourly volume cap). */
export function visitValue(deal: TradeDeal, qty: number, credits: number, unit: number): number {
  return Math.floor(qty * unit) + credits;
}

/**
 * The deal's state after a visit ends (settled, raided, or skipped). Recurring
 * deals count down and reschedule; a one-off ends after a completed visit or
 * after exhausting its retry budget on skips.
 */
export function afterVisit(
  deal: TradeDeal,
  outcome: 'completed' | 'raided' | 'skipped',
  nowMs: number,
): { state: DealState; nextVisitAtMs: number | null; visitsLeft: number | null; attempts: number } {
  if (deal.recurrenceMin === null) {
    if (outcome === 'skipped') {
      const attempts = deal.attempts + 1;
      if (attempts >= ONE_OFF_MAX_ATTEMPTS) return { state: 'failed', nextVisitAtMs: null, visitsLeft: 0, attempts };
      return { state: 'scheduled', nextVisitAtMs: nowMs + ONE_OFF_RETRY_MS, visitsLeft: 1, attempts };
    }
    return { state: outcome === 'completed' ? 'settled' : 'failed', nextVisitAtMs: null, visitsLeft: 0, attempts: 0 };
  }
  // Recurring: a skip does not consume a visit; a completed or raided one does.
  const consumed = outcome === 'skipped' ? 0 : 1;
  const left = deal.visitsLeft === null ? null : deal.visitsLeft - consumed;
  if (left !== null && left <= 0) return { state: 'settled', nextVisitAtMs: null, visitsLeft: 0, attempts: 0 };
  return {
    state: 'scheduled',
    nextVisitAtMs: nowMs + deal.recurrenceMin * 60_000,
    visitsLeft: left,
    attempts: 0,
  };
}

/** Deals that still hold one of the network's 3 slots. */
export function isActiveDeal(d: TradeDeal): boolean {
  return d.state === 'scheduled' || d.state === 'inbound' || d.state === 'docked' || d.state === 'departing';
}
