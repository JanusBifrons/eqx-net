import { describe, expect, it } from 'vitest';
import type { IPersistenceSink } from '../../core/contracts/IPersistenceSink.js';
import { CAPITAL_STARTING_MINERALS } from '../../core/structures/structureGridConstants.js';
import { quotePacked } from '../../core/economy/market.js';
import { BASE_PRICES, REP_MAX } from '../../shared-types/economy.js';
import { emptyHold } from '../../core/cargo/hold.js';
import { seededRng } from '../../shared-types/research.js';
import { HoldStore } from '../cargo/HoldStore.js';
import { capitalCrateItem } from '../structures/StructurePlacementSubsystem.js';
import { EconomyStore } from './EconomyStore.js';
import { TradeDirector } from './TradeDirector.js';
import {
  CAPITAL_CRATE_PRODUCT, CAPITAL_NOT_BOUGHT, capitalCrateBillValue, packedSellRefusal, traderPackedItem,
} from './capitalCrateTrade.js';

const sink = { enqueueCritical: () => {}, enqueueVolatile: () => {} } as unknown as IPersistenceSink;

/** A board refreshed once with a seeded rng (no rooms: only the offers). */
function board(seed: number): TradeDirector {
  const store = new EconomyStore({ persistence: () => sink, now: () => 1_000_000 });
  const holds = new HoldStore({ persistence: () => sink, now: () => 1_000_000 });
  return new TradeDirector(new Map(), store, holds, { rng: seededRng(seed), nowMs: () => 1_000_000, controlIntervalMs: 1_000_000 });
}

const mineralsWorth = CAPITAL_STARTING_MINERALS * BASE_PRICES.minerals;

describe('Capital crate on the trade board (playable base loop)', () => {
  it('the board can offer a Capital crate', () => {
    for (const seed of [1, 7, 42]) {
      const dir = board(seed);
      dir.start();
      try {
        const offers = dir.offersFor('p1').filter((o) => o.product === CAPITAL_CRATE_PRODUCT);
        expect(offers).toHaveLength(1);
        expect(offers[0]).toMatchObject({ kind: 'buy', good: null, maxQty: 1 });
        // Other structures keep their own slots.
        expect(dir.offersFor('p1').filter((o) => o.product?.startsWith('structure:') && o.product !== CAPITAL_CRATE_PRODUCT).length).toBeGreaterThan(0);
      } finally {
        dir.stop();
      }
    }
  });

  it('its price is above its minerals\' worth', () => {
    expect(capitalCrateBillValue()).toBe(mineralsWorth);
    // Even the best trader reputation pays more than the minerals inside.
    for (const rep of [-REP_MAX, 0, REP_MAX]) expect(quotePacked(capitalCrateBillValue(), rep)).toBeGreaterThan(mineralsWorth);
    const dir = board(3);
    dir.start();
    try {
      const offer = dir.offersFor('p1').find((o) => o.product === CAPITAL_CRATE_PRODUCT)!;
      expect(offer.unitPrice).toBeGreaterThan(mineralsWorth);
    } finally {
      dir.stop();
    }
  });

  it('a bought crate is fresh: its own uid and the full mineral bank', () => {
    const item = traderPackedItem(CAPITAL_CRATE_PRODUCT, 50);
    expect(item).toMatchObject({ product: CAPITAL_CRATE_PRODUCT, quality: 50, minerals: CAPITAL_STARTING_MINERALS });
    expect(item.uid).toBeDefined();
    expect(traderPackedItem('structure:smelter', 50)).toEqual({ product: 'structure:smelter', quality: 50 });
  });

  it('a Capital crate cannot be sold', () => {
    const hold = emptyHold();
    const crate = capitalCrateItem(50, 1234);
    hold.packed = [crate, { product: 'structure:smelter', quality: 50 }];
    expect(packedSellRefusal(hold, [crate.uid!])).toBe(CAPITAL_NOT_BOUGHT);
    expect(packedSellRefusal(hold, [CAPITAL_CRATE_PRODUCT])).toBe(CAPITAL_NOT_BOUGHT);
    expect(packedSellRefusal(hold, ['structure:smelter'])).toBeNull();
    expect(packedSellRefusal(hold, [])).toBeNull();
  });
});
