import { describe, expect, it } from 'vitest';
import { FREIGHT_CUT_MAX, FREIGHT_CUT_MIN, TRADERS_CUT, carrierCut, chooseCarrier, runsOwnFreight } from './freight.js';
import { MINOR_FACTIONS } from '../../shared-types/factions.js';

describe('freight contracting (v4 C)', () => {
  it('powers, the Traders and freight companies carry their own goods', () => {
    expect(runsOwnFreight('core')).toBe(true);
    expect(runsOwnFreight('traders')).toBe(true);
    for (const m of MINOR_FACTIONS) expect(runsOwnFreight(m.id), m.id).toBe(m.specialty === 'freight');
    expect(chooseCarrier('core', 'core')).toEqual({ carrier: 'core', cut: 0 });
  });

  it('anyone else contracts the cheapest freight carrier in the region', () => {
    for (const m of MINOR_FACTIONS) {
      if (m.specialty === 'freight') continue;
      const c = chooseCarrier(m.id, m.region ?? null);
      expect(c.carrier).not.toBe(m.id);
      expect(c.cut).toBeGreaterThan(0);
      const options = MINOR_FACTIONS.filter((f) => f.region === m.region && f.specialty === 'freight').map((f) => carrierCut(f.id));
      expect(c.cut).toBe(Math.min(TRADERS_CUT, ...options));
    }
    // A player contracts too (here, with no region: the Traders).
    expect(chooseCarrier('face0000-0000-4000-8000-000000000001', null)).toEqual({ carrier: 'traders', cut: TRADERS_CUT });
  });

  it('a carrier’s cut is fixed and in range', () => {
    for (const m of MINOR_FACTIONS) {
      const cut = carrierCut(m.id);
      expect(cut).toBe(carrierCut(m.id));
      expect(cut).toBeGreaterThanOrEqual(FREIGHT_CUT_MIN);
      expect(cut).toBeLessThanOrEqual(FREIGHT_CUT_MAX);
    }
  });
});
