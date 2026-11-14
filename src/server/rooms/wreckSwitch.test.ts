import { describe, expect, it } from 'vitest';
import { wreckSwitchOn } from './wreckSwitch.js';

describe('wreckSwitchOn (break-up switched on by default, owner 2026-11-14)', () => {
  it('is on in a room that says nothing', () => {
    expect(wreckSwitchOn(undefined, undefined)).toBe(true);
    expect(wreckSwitchOn('', undefined)).toBe(true);
    expect(wreckSwitchOn(undefined, true)).toBe(true);
  });
  it('a room opts out with false', () => {
    expect(wreckSwitchOn(undefined, false)).toBe(false);
  });
  it('env 0 forces it off, even where the room asks for it', () => {
    expect(wreckSwitchOn('0', undefined)).toBe(false);
    expect(wreckSwitchOn('0', true)).toBe(false);
  });
  it('env 1 forces it on, even in a room that opted out', () => {
    expect(wreckSwitchOn('1', false)).toBe(true);
  });
});
