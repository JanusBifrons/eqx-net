import { describe, expect, it } from 'vitest';
import { REGION_PRICE_MAX, REGION_PRICE_MIN, regionFactor, regionPriceFactors } from './regionalPrices.js';
import { TARGET_MINUTES } from './convoys.js';

describe('regional prices (T3)', () => {
  it('a region short of a good pays more; a glut sells cheaper; balance is 1', () => {
    expect(regionFactor(0, 1000)).toBeGreaterThan(1);
    expect(regionFactor(5000, 0)).toBeLessThan(1);
    expect(regionFactor(400, 400)).toBeCloseTo(1, 9);
  });

  it('is clamped', () => {
    expect(regionFactor(0, 1e9)).toBe(REGION_PRICE_MAX);
    expect(regionFactor(1e9, 0)).toBe(REGION_PRICE_MIN);
  });

  it('sums each region and leaves untouched goods out', () => {
    const f = regionPriceFactors([
      { region: 'core', stock: { alloy: 0 }, uses: { alloy: 10 } },
      { region: 'core', stock: { alloy: 10 }, uses: {} },
      { region: 'verdant', stock: { alloy: 2000 }, uses: {} },
    ]);
    const core = f.get('core')!, verdant = f.get('verdant')!;
    // core: stock 10 against a target of 10/min × TARGET_MINUTES.
    expect(core.alloy).toBeCloseTo(regionFactor(10, 10 * TARGET_MINUTES), 3);
    expect(core.alloy!).toBeGreaterThan(1);
    expect(verdant.alloy!).toBeLessThan(1);
    expect(core.fuel).toBeUndefined();
  });

  it('a raided region gets dearer: less stock, same need', () => {
    const before = regionPriceFactors([{ region: 'r', stock: { fuel: 300 }, uses: { fuel: 30 } }]).get('r')!.fuel!;
    const after = regionPriceFactors([{ region: 'r', stock: { fuel: 50 }, uses: { fuel: 30 } }]).get('r')!.fuel!;
    expect(after).toBeGreaterThan(before);
  });
});
