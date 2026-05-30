import { describe, it, expect } from 'vitest';
import { readFxKillSwitches } from './fxKillSwitches.js';

describe('readFxKillSwitches', () => {
  it('returns both false when no flags set', () => {
    expect(readFxKillSwitches('')).toEqual({
      filtersDisabled: false,
      particlesDisabled: false,
    });
    expect(readFxKillSwitches('?room=feel-test-25')).toEqual({
      filtersDisabled: false,
      particlesDisabled: false,
    });
  });

  it('reads ?nofilters=1', () => {
    expect(readFxKillSwitches('?nofilters=1')).toEqual({
      filtersDisabled: true,
      particlesDisabled: false,
    });
  });

  it('reads ?noparticles=1', () => {
    expect(readFxKillSwitches('?noparticles=1')).toEqual({
      filtersDisabled: false,
      particlesDisabled: true,
    });
  });

  it('reads both flags together', () => {
    expect(readFxKillSwitches('?nofilters=1&noparticles=1')).toEqual({
      filtersDisabled: true,
      particlesDisabled: true,
    });
  });

  it('co-exists with other URL params', () => {
    const search = '?room=feel-test-25&diag=1&nofilters=1&testId=abc&noparticles=1';
    expect(readFxKillSwitches(search)).toEqual({
      filtersDisabled: true,
      particlesDisabled: true,
    });
  });

  it('ignores nofilters=0 / noparticles=0 / other values', () => {
    expect(readFxKillSwitches('?nofilters=0&noparticles=2')).toEqual({
      filtersDisabled: false,
      particlesDisabled: false,
    });
  });
});
