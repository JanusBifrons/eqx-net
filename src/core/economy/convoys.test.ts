import { describe, expect, it } from 'vitest';
import { matchConvoys, needOf, spareOf, TARGET_MINUTES, type BaseTradeView } from './convoys.js';

function base(key: string, sectorKey: string, over: Partial<BaseTradeView> = {}): BaseTradeView {
  return { key, sectorKey, stock: {}, freeCapacity: 10_000, uses: {}, makes: {}, ...over };
}
const HOPS: Record<string, number> = { 'a|b': 1, 'b|a': 1, 'a|c': 3, 'c|a': 3, 'b|c': 2, 'c|b': 2 };
const hops = (x: string, y: string): number => (x === y ? 0 : HOPS[`${x}|${y}`] ?? Infinity);
const OPTS = { haulerCapacity: 400, maxConvoys: 10, hops };

describe('convoy needs and spare (T2)', () => {
  it('asks only below the low-water mark, and refills to the target', () => {
    const b = base('r', 'a', { uses: { minerals: 10 }, stock: { minerals: 60 } });
    expect(needOf(b, 'minerals')).toBe(0); // 60 ≥ 50 % of 100
    b.stock.minerals = 20;
    expect(needOf(b, 'minerals')).toBe(10 * TARGET_MINUTES - 20);
  });

  it('never asks for more than fits in storage', () => {
    const b = base('r', 'a', { uses: { alloy: 10 }, stock: {}, freeCapacity: 30 }); // alloy weighs 2
    expect(needOf(b, 'alloy')).toBe(15);
  });

  it('spares only beyond its own use, and only a worthwhile load', () => {
    const b = base('m', 'a', { uses: { fuel: 1 }, stock: { fuel: 12 } });
    expect(spareOf(b, 'fuel')).toBe(0); // keeps 10, 2 spare × weight below the minimum
    b.stock.fuel = 400;
    expect(spareOf(b, 'fuel')).toBe(390);
  });
});

describe('matchConvoys (T2)', () => {
  it('sends from the nearest exporter, capped by the hauler', () => {
    const importer = base('imp', 'a', { uses: { alloy: 50 } });
    const near = base('near', 'b', { stock: { alloy: 1000 } });
    const far = base('far', 'c', { stock: { alloy: 1000 } });
    const plans = matchConvoys([far, importer, near], OPTS);
    expect(plans).toEqual([{ from: 'near', to: 'imp', good: 'alloy', qty: 200 }]); // 400 cap / weight 2
  });

  it('reserves spare: two importers do not count on the same units', () => {
    const ex = base('ex', 'b', { stock: { minerals: 300 } }); // minerals weigh 0.1
    const i1 = base('i1', 'a', { uses: { minerals: 25 } });
    const i2 = base('i2', 'c', { uses: { minerals: 25 } });
    const plans = matchConvoys([ex, i1, i2], OPTS);
    const total = plans.reduce((s, p) => s + p.qty, 0);
    expect(total).toBeLessThanOrEqual(300);
    expect(plans.map((p) => p.to).sort()).toEqual(['i1', 'i2']);
  });

  it('never trades a base with itself, skips in-flight deliveries, and is deterministic', () => {
    const self = base('s', 'a', { uses: { alloy: 10 }, stock: { alloy: 0 } });
    expect(matchConvoys([self], OPTS)).toEqual([]);
    const imp = base('imp', 'a', { uses: { alloy: 50 } });
    const ex = base('ex', 'b', { stock: { alloy: 1000 } });
    expect(matchConvoys([imp, ex], { ...OPTS, inFlight: new Set(['imp|alloy']) })).toEqual([]);
    expect(matchConvoys([imp, ex], OPTS)).toEqual(matchConvoys([ex, imp], OPTS));
  });

  it('serves the most starved importer first under a convoy cap', () => {
    const ex = base('ex', 'b', { stock: { alloy: 5000 } });
    const starving = base('z-starving', 'a', { uses: { alloy: 10 }, stock: { alloy: 0 } });
    const low = base('a-low', 'c', { uses: { alloy: 10 }, stock: { alloy: 40 } });
    const plans = matchConvoys([ex, low, starving], { ...OPTS, maxConvoys: 1 });
    expect(plans[0]!.to).toBe('z-starving');
  });
});
