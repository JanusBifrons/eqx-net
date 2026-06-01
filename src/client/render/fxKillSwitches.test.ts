import { describe, it, expect } from 'vitest';
import { readFxKillSwitches } from './fxKillSwitches.js';

const ALL_FALSE = {
  filtersDisabled: false,
  particlesDisabled: false,
  beamsDisabled: false,
  dmgNumbersDisabled: false,
  healthBarsDisabled: false,
};

describe('readFxKillSwitches', () => {
  it('returns all false when no flags set', () => {
    expect(readFxKillSwitches('')).toEqual(ALL_FALSE);
    expect(readFxKillSwitches('?room=feel-test-25')).toEqual(ALL_FALSE);
  });

  it('reads ?nofilters=1', () => {
    expect(readFxKillSwitches('?nofilters=1')).toEqual({ ...ALL_FALSE, filtersDisabled: true });
  });

  it('reads ?noparticles=1', () => {
    expect(readFxKillSwitches('?noparticles=1')).toEqual({ ...ALL_FALSE, particlesDisabled: true });
  });

  it('reads ?nobeams=1', () => {
    expect(readFxKillSwitches('?nobeams=1')).toEqual({ ...ALL_FALSE, beamsDisabled: true });
  });

  it('reads ?nodmgnumbers=1', () => {
    expect(readFxKillSwitches('?nodmgnumbers=1')).toEqual({ ...ALL_FALSE, dmgNumbersDisabled: true });
  });

  it('reads ?nohealthbars=1', () => {
    expect(readFxKillSwitches('?nohealthbars=1')).toEqual({ ...ALL_FALSE, healthBarsDisabled: true });
  });

  it('reads multiple flags together', () => {
    expect(readFxKillSwitches('?nofilters=1&noparticles=1&nobeams=1')).toEqual({
      ...ALL_FALSE,
      filtersDisabled: true,
      particlesDisabled: true,
      beamsDisabled: true,
    });
  });

  it('co-exists with other URL params', () => {
    const search = '?room=feel-test-25&diag=1&nobeams=1&testId=abc&nodmgnumbers=1';
    expect(readFxKillSwitches(search)).toEqual({
      ...ALL_FALSE,
      beamsDisabled: true,
      dmgNumbersDisabled: true,
    });
  });

  it('ignores =0 / other values', () => {
    expect(readFxKillSwitches('?nofilters=0&nobeams=2&nodmgnumbers=0')).toEqual(ALL_FALSE);
  });
});
