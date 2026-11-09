import { describe, it, expect } from 'vitest';
import { readFxKillSwitches } from './fxKillSwitches.js';

const DEFAULTS = {
  filtersDisabled: false,
  particlesDisabled: false,
  beamsDisabled: false,
  dmgNumbersDisabled: false,
  healthBarsDisabled: false,
  // The HUD shows own hull/shield, so own-ship damage numbers default off.
  selfDmgNumbersDisabled: true,
  cleanWorld: false,
};

describe('readFxKillSwitches', () => {
  it('returns the defaults when no flags set', () => {
    expect(readFxKillSwitches('')).toEqual(DEFAULTS);
    expect(readFxKillSwitches('?room=feel-test-25')).toEqual(DEFAULTS);
  });

  it('reads ?nofilters=1', () => {
    expect(readFxKillSwitches('?nofilters=1')).toEqual({ ...DEFAULTS, filtersDisabled: true });
  });

  it('reads ?noparticles=1', () => {
    expect(readFxKillSwitches('?noparticles=1')).toEqual({ ...DEFAULTS, particlesDisabled: true });
  });

  it('reads ?nobeams=1', () => {
    expect(readFxKillSwitches('?nobeams=1')).toEqual({ ...DEFAULTS, beamsDisabled: true });
  });

  it('hides own-ship damage numbers by default; noselfdmg=0 turns them on', () => {
    expect(readFxKillSwitches('?noselfdmg=1')).toEqual(DEFAULTS);
    expect(readFxKillSwitches('?noselfdmg=0')).toEqual({ ...DEFAULTS, selfDmgNumbersDisabled: false });
  });

  it('reads ?cleanworld=1 (showcase capture: no debug world overlays)', () => {
    expect(readFxKillSwitches('?cleanworld=1')).toEqual({ ...DEFAULTS, cleanWorld: true });
  });

  it('reads ?nodmgnumbers=1', () => {
    expect(readFxKillSwitches('?nodmgnumbers=1')).toEqual({ ...DEFAULTS, dmgNumbersDisabled: true });
  });

  it('reads ?nohealthbars=1', () => {
    expect(readFxKillSwitches('?nohealthbars=1')).toEqual({ ...DEFAULTS, healthBarsDisabled: true });
  });

  it('reads multiple flags together', () => {
    expect(readFxKillSwitches('?nofilters=1&noparticles=1&nobeams=1')).toEqual({
      ...DEFAULTS,
      filtersDisabled: true,
      particlesDisabled: true,
      beamsDisabled: true,
    });
  });

  it('co-exists with other URL params', () => {
    const search = '?room=feel-test-25&diag=1&nobeams=1&testId=abc&nodmgnumbers=1';
    expect(readFxKillSwitches(search)).toEqual({
      ...DEFAULTS,
      beamsDisabled: true,
      dmgNumbersDisabled: true,
    });
  });

  it('ignores =0 / other values', () => {
    expect(readFxKillSwitches('?nofilters=0&nobeams=2&nodmgnumbers=0')).toEqual(DEFAULTS);
  });
});
