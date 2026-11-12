import { describe, it, expect } from 'vitest';
import { glideToward, TIME_SCALE_SLEW_PER_S } from './timeScale.js';

describe('glideToward (the shared speed dimmer)', () => {
  it('moves at the slew rate and stops at the target', () => {
    expect(TIME_SCALE_SLEW_PER_S).toBe(0.5);
    expect(glideToward(1, 2, 1)).toBeCloseTo(1.5);
    expect(glideToward(1, 0.4, 0.5)).toBeCloseTo(0.75);
    expect(glideToward(1, 2, 5)).toBe(2);
    expect(glideToward(1, 0.4, 5)).toBe(0.4);
    expect(glideToward(1.3, 1.3, 1)).toBe(1.3);
    expect(glideToward(1, 2, -3)).toBe(1); // no time, no move
  });
});
