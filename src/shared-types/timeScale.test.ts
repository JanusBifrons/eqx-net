import { describe, it, expect } from 'vitest';
import { glideToward, TIME_SCALE_HALVINGS_PER_S } from './timeScale.js';

describe('glideToward (the shared speed dimmer: a steady ratio)', () => {
  it('doubles or halves once per second and stops at the target', () => {
    expect(TIME_SCALE_HALVINGS_PER_S).toBe(1);
    expect(glideToward(1, 2, 1)).toBeCloseTo(2);
    expect(glideToward(1, 4, 1)).toBeCloseTo(2);
    expect(glideToward(1, 0.25, 1)).toBeCloseTo(0.5);
    expect(glideToward(1, 2, 0.5)).toBeCloseTo(Math.SQRT2);
    expect(glideToward(1, 2, 5)).toBe(2);
    expect(glideToward(1.3, 1.3, 1)).toBe(1.3);
    expect(glideToward(1, 2, -3)).toBe(1); // no time, no move
  });

  it('4× → 0.25× takes 4 s, evenly (one halving a second)', () => {
    let s = 4;
    const seen: number[] = [];
    for (let t = 0; t < 4; t++) { s = glideToward(s, 0.25, 1); seen.push(s); }
    expect(seen.map((v) => +v.toFixed(5))).toEqual([2, 1, 0.5, 0.25]);
  });
});
