import { describe, expect, it } from 'vitest';
import type { BlueprintItem } from '../../shared-types/items.js';
import { BPO_RUNS_EQUIV, MODULE_BILL, blueprintValue, productBill } from '../../shared-types/blueprintMarket.js';
import { hullBillValue, packBillValue } from '../../shared-types/recipes.js';
import { BLUEPRINT_OFFERS_ON_BOARD, BlueprintMarket, bpBuyPrice, bpSellPrice } from './BlueprintMarket.js';

const bp = (over: Partial<BlueprintItem> = {}): BlueprintItem => ({
  uid: 'b1', product: 'hull:gunship', kind: 'bpc', runs: 4, material: 0, output: 0, research: 0, ...over,
});

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('blueprint value (economy v2 W6)', () => {
  it('prices from what the product costs to make', () => {
    expect(productBill('hull:gunship')).toBe(hullBillValue('gunship'));
    expect(productBill('structure:smelter')).toBe(packBillValue('smelter'));
    expect(productBill('module:bp-missile-rack')).toBe(MODULE_BILL);
    expect(productBill('recipe:fab_components')).toBeGreaterThan(0);
    expect(productBill('nonsense')).toBe(0);
    expect(blueprintValue(bp({ product: 'nonsense' }))).toBe(0);
  });

  it('more runs, better stats and originals are worth more', () => {
    expect(blueprintValue(bp({ runs: 8 }))).toBeGreaterThan(blueprintValue(bp({ runs: 4 })));
    expect(blueprintValue(bp({ material: 10, output: 100 }))).toBeGreaterThan(blueprintValue(bp()));
    expect(blueprintValue(bp({ kind: 'bpo', runs: null }))).toBe(blueprintValue(bp({ runs: BPO_RUNS_EQUIV })));
    expect(blueprintValue(bp({ runs: 0 }))).toBe(0);
  });

  it('traders sell above value and buy below it; good standing helps both; bound ones are unsellable', () => {
    const b = bp();
    expect(bpBuyPrice(b, 0)).toBeGreaterThan(bpSellPrice(b, 0));
    expect(bpBuyPrice(b, 1000)).toBeLessThan(bpBuyPrice(b, 0));
    expect(bpSellPrice(b, 1000)).toBeGreaterThan(bpSellPrice(b, 0));
    expect(bpSellPrice({ ...b, bound: true }, 0)).toBe(0);
  });
});

describe('BlueprintMarket board', () => {
  it('keeps the board stocked with real, priced blueprints; a bought one leaves', () => {
    const m = new BlueprintMarket({ rng: seeded(5), now: () => 1000 });
    const offers = m.offersFor(0);
    expect(offers).toHaveLength(BLUEPRINT_OFFERS_ON_BOARD);
    for (const o of offers) {
      expect(o.price).toBeGreaterThan(0);
      expect(o.name).not.toContain(':');
    }
    const first = offers[0]!;
    const got = m.peek(first.id)!;
    expect(got.uid).toBeTruthy();
    got.runs = 999; // peek returns a copy
    expect(m.peek(first.id)!.runs).not.toBe(999);
    m.remove(first.id);
    expect(m.peek(first.id)).toBeNull();
    expect(m.offersFor(0).map((o) => o.id)).not.toContain(first.id);
    expect(m.offersFor(0)).toHaveLength(BLUEPRINT_OFFERS_ON_BOARD); // restocked
  });

  it('expired offers drop off', () => {
    let now = 0;
    const m = new BlueprintMarket({ rng: seeded(2), now: () => now });
    const ids = m.offersFor(0).map((o) => o.id);
    now = 10 * 60 * 60 * 1000;
    expect(m.offersFor(0).some((o) => ids.includes(o.id))).toBe(false);
  });
});
