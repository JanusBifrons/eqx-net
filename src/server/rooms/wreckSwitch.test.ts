import { describe, expect, it } from 'vitest';
import { structureWreckSwitchOn, wreckSwitchOn } from './wreckSwitch.js';

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

describe('structureWreckSwitchOn (structure break-up, ON since the owner look OK 2026-11-22)', () => {
  it('is on in a room that says nothing', () => {
    expect(structureWreckSwitchOn(undefined, undefined)).toBe(true);
    expect(structureWreckSwitchOn('', true)).toBe(true);
  });
  it('a room opts out with false', () => {
    expect(structureWreckSwitchOn(undefined, false)).toBe(false);
    expect(structureWreckSwitchOn('', false)).toBe(false);
  });
  it('the env wins either way', () => {
    expect(structureWreckSwitchOn('0', true)).toBe(false);
    expect(structureWreckSwitchOn('1', undefined)).toBe(true);
  });
});
