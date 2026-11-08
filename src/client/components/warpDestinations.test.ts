/** Warp-to destinations (wrap-up plan W1a). */
import { describe, expect, it } from 'vitest';
import { sectorSites, isWarpDropPoint } from '../../core/galaxy/sectorSites';
import { formatKm, WARP_FAR_KM, warpDestinations } from './warpDestinations';

describe('warpDestinations', () => {
  it('lists every pocket, nearest first, with drop points the server accepts', () => {
    const sites = sectorSites('sol-prime');
    const d = warpDestinations('sol-prime', 0, 0);
    expect(d).toHaveLength(sites.length);
    for (let i = 1; i < d.length; i++) expect(d[i]!.distKm).toBeGreaterThanOrEqual(d[i - 1]!.distKm);
    // (The pocket the ship is in has no rim to drop at; it can't be picked.)
    for (const x of d) if (!x.here) expect(isWarpDropPoint('sol-prime', x.dropX, x.dropY, true)).toBe(true);
  });

  it('marks the pocket the ship is in, names gates by their system, groups far ones', () => {
    const d = warpDestinations('sol-prime', 0, 0);
    const home = d.find((x) => x.kind === 'home')!;
    expect(home.here).toBe(true);
    expect(home.distKm).toBe(0);
    const gate = d.find((x) => x.kind === 'gate');
    if (gate) expect(gate.label).toMatch(/^Gate to /);
    for (const x of d) expect(x.far).toBe(x.distKm > WARP_FAR_KM);
  });

  it('formats distances', () => {
    expect(formatKm(0.4)).toBe('<1 km');
    expect(formatKm(52.6)).toBe('53 km');
  });
});
