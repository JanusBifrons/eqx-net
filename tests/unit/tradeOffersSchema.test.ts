/**
 * The client's offers schema must accept every offer the server's board makes.
 *
 * Bug (found while filming the trade showcase, 2026-11-02): since economy v2
 * W4b the TradeDirector board also lists PACKED structures and hulls as
 * `{ good: null, product: 'structure:refinery' }`. The client schema required a
 * good, so ONE packed offer failed the whole `/trade/offers` parse and the
 * Trade tab showed "No offers right now" to every player.
 */
import { describe, it, expect } from 'vitest';
import { TradeOffersResponseSchema } from '../../src/shared-types/economy.js';

describe('TradeOffersResponseSchema', () => {
  const goodsOffer = { offerId: 'of-1', kind: 'sell', good: 'salvage', unitPrice: 5.4, maxQty: 40, expiresAtMs: 1 };
  const packedOffer = {
    offerId: 'of-2',
    kind: 'buy',
    good: null,
    product: 'structure:refinery',
    unitPrice: 637,
    maxQty: 2,
    expiresAtMs: 1,
  };

  it('accepts a board that mixes goods and packed offers', () => {
    const r = TradeOffersResponseSchema.safeParse({ offers: [goodsOffer, packedOffer] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.offers[1]).toMatchObject({ good: null, product: 'structure:refinery' });
  });

  it('still rejects an unknown good', () => {
    expect(TradeOffersResponseSchema.safeParse({ offers: [{ ...goodsOffer, good: 'unobtainium' }] }).success).toBe(false);
  });
});
