import { describe, expect, it } from 'vitest';
import {
  applyFill,
  createMarket,
  driftMarket,
  midPrice,
  quoteBuy,
  quoteSell,
  repPriceFactor,
} from './market.js';
import { applyRep, giftRepGain, neutralRep, robotTruce, tradersRefuse, waveIntervalFactor } from './reputation.js';
import { afterVisit, buyCost, planVisit, sellProceeds, ONE_OFF_MAX_ATTEMPTS, type NetworkSnapshot, type TradeDeal } from './deals.js';
import { BASE_PRICES, HAULING_FEE, PRICE_FLOOR_MUL, REP_MAX } from '../../shared-types/economy.js';

const NET: NetworkSnapshot = { exists: true, underAttack: false, goods: { salvage: 50 }, credits: 1000, freeCapacity: 100 };

function deal(over: Partial<TradeDeal> = {}): TradeDeal {
  return {
    dealId: 'd1', ownerId: 'p1', kind: 'sell', allegiance: 'traders', good: 'salvage', qty: 20, credits: 0,
    sectorKey: 's', networkUid: 'st-1', unitPrice: 5, priceBandPct: 10, recurrenceMin: null, visitsLeft: 1,
    state: 'scheduled', nextVisitAtMs: 0, createdAtMs: 0, attempts: 0, run: null, ...over,
  };
}

describe('market', () => {
  it('neutral supply prices at base; traders buy below and sell above mid', () => {
    const m = createMarket(0);
    expect(midPrice(m, 'alloy')).toBe(BASE_PRICES.alloy);
    expect(quoteSell(m, 'alloy', 0)).toBeLessThan(BASE_PRICES.alloy);
    expect(quoteBuy(m, 'alloy', 0)).toBeGreaterThan(BASE_PRICES.alloy);
  });

  it('dumping a good drops its price (and never below the floor); buying it back costs more', () => {
    const m = createMarket(0);
    const before = quoteSell(m, 'salvage', 0);
    applyFill(m, 'salvage', 1000, 'sell');
    expect(quoteSell(m, 'salvage', 0)).toBeLessThan(before);
    applyFill(m, 'salvage', 1_000_000, 'sell');
    expect(midPrice(m, 'salvage')).toBeCloseTo(BASE_PRICES.salvage * PRICE_FLOOR_MUL);
    // Wash trade: buying back is always dearer than what selling paid.
    const m2 = createMarket(0);
    const sold = quoteSell(m2, 'core', 0);
    applyFill(m2, 'core', 10, 'sell');
    expect(quoteBuy(m2, 'core', 0)).toBeGreaterThan(sold);
  });

  it('reputation swings prices by up to ±15 % in the player’s favour', () => {
    expect(repPriceFactor(REP_MAX)).toBeCloseTo(1.15);
    expect(repPriceFactor(-REP_MAX)).toBeCloseTo(0.85);
    const m = createMarket(0);
    expect(quoteSell(m, 'alloy', REP_MAX)).toBeGreaterThan(quoteSell(m, 'alloy', 0));
    expect(quoteBuy(m, 'alloy', REP_MAX)).toBeLessThan(quoteBuy(m, 'alloy', 0));
  });

  it('supply mean-reverts toward neutral over time', () => {
    const m = createMarket(0);
    m.supply.alloy = 50_000;
    driftMarket(m, 8 * 60 * 60 * 1000, () => 0.5); // 4 half-lives, zero noise
    expect(m.supply.alloy).toBeCloseTo(50_000 / 16, 0);
  });
});

describe('reputation', () => {
  it('clamps, gates refusal + truce, and gifts have diminishing returns', () => {
    const t = neutralRep();
    expect(applyRep(t, 'traders', -5000)).toBe(-REP_MAX);
    expect(tradersRefuse(t.traders)).toBe(true);
    expect(robotTruce(499)).toBe(false);
    expect(robotTruce(500)).toBe(true);
    const fresh = giftRepGain(1000, 0);
    const tired = giftRepGain(1000, 6000);
    expect(fresh).toBeGreaterThan(tired);
    expect(giftRepGain(1_000_000, 0)).toBe(150); // per-gift cap
    expect(waveIntervalFactor(-500)).toBe(1);
    expect(waveIntervalFactor(REP_MAX)).toBe(3);
  });
});

describe('planVisit', () => {
  it('skips with the right reason', () => {
    expect(planVisit(deal(), { ...NET, exists: false }, 5, 0)).toEqual({ go: false, reason: 'no-storage' });
    expect(planVisit(deal(), { ...NET, underAttack: true }, 5, 0)).toEqual({ go: false, reason: 'under-attack' });
    expect(planVisit(deal(), NET, 5, -900)).toEqual({ go: false, reason: 'refused' });
    expect(planVisit(deal(), { ...NET, goods: {} }, 5, 0)).toEqual({ go: false, reason: 'nothing-to-trade' });
  });

  it('a sell fills partially when the base has less than pledged', () => {
    const p = planVisit(deal({ qty: 80 }), NET, 5, 0);
    expect(p).toMatchObject({ go: true, qty: 50, partial: true, unitPrice: 5 });
  });

  it('a recurring visit re-quotes inside the band and skips outside it', () => {
    const rec = deal({ recurrenceMin: 10, visitsLeft: null, unitPrice: 5, priceBandPct: 10 });
    expect(planVisit(rec, NET, 5.4, 0)).toMatchObject({ go: true, unitPrice: 5.4 });
    expect(planVisit(rec, NET, 6, 0)).toEqual({ go: false, reason: 'out-of-band' });
  });

  it('a buy is bounded by credits (fee included) and free capacity', () => {
    const b = deal({ kind: 'buy', good: 'alloy', qty: 100, unitPrice: 30 });
    // capacity 100 / alloy weight 2 = 50; credits 1000 → floor((1000-5)/30)=33
    const p = planVisit(b, NET, 30, 0);
    expect(p).toMatchObject({ go: true, qty: 33, partial: true });
    expect(buyCost(33, 30)).toBeLessThanOrEqual(NET.credits);
  });

  it('proceeds and costs include the hauling fee', () => {
    expect(sellProceeds(10, 5)).toBe(50 - HAULING_FEE);
    expect(buyCost(10, 5)).toBe(50 + HAULING_FEE);
  });
});

describe('afterVisit', () => {
  it('a one-off retries skips, then fails after the attempt budget', () => {
    let d = deal();
    for (let i = 1; i < ONE_OFF_MAX_ATTEMPTS; i++) {
      const r = afterVisit(d, 'skipped', 0);
      expect(r.state).toBe('scheduled');
      d = { ...d, attempts: r.attempts };
    }
    expect(afterVisit(d, 'skipped', 0).state).toBe('failed');
    expect(afterVisit(deal(), 'completed', 0).state).toBe('settled');
  });

  it('a recurring deal counts down completed visits; skips do not consume one', () => {
    const rec = deal({ recurrenceMin: 30, visitsLeft: 2 });
    expect(afterVisit(rec, 'skipped', 0)).toMatchObject({ state: 'scheduled', visitsLeft: 2, nextVisitAtMs: 30 * 60_000 });
    expect(afterVisit(rec, 'completed', 0)).toMatchObject({ state: 'scheduled', visitsLeft: 1 });
    expect(afterVisit({ ...rec, visitsLeft: 1 }, 'raided', 0).state).toBe('settled');
  });
});
