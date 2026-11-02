import { describe, expect, it } from 'vitest';
import { sumCounts } from './countMaps.js';

describe('sumCounts', () => {
  it('adds per key and returns an input unchanged when the other is empty', () => {
    const a = new Map([['x', 2], ['y', 1]]);
    const b = new Map([['y', 3], ['z', 4]]);
    expect([...sumCounts(a, b)]).toEqual([['x', 2], ['y', 4], ['z', 4]]);
    expect(sumCounts(a, new Map())).toBe(a);
    expect(sumCounts(new Map(), b)).toBe(b);
  });
});
