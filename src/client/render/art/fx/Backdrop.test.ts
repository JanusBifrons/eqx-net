/**
 * New backdrop (plan iridescent-seeking-rainbow v3, B2): which nebula a
 * sector gets. Stable per sector, all three types used across the galaxy, and
 * the red-pink emission type kept faint (the user's pick).
 */
import { describe, it, expect } from 'vitest';
import { sectorNebula } from './Backdrop.js';
import { GALAXY_SECTORS } from '../../../../core/galaxy/galaxy.js';

describe('sectorNebula', () => {
  it('is the same for a sector every visit', () => {
    expect(sectorNebula('sol-prime')).toEqual(sectorNebula('sol-prime'));
    expect(sectorNebula(null)).toEqual(sectorNebula(null));
  });

  it('uses all three types across the galaxy, with few distinct textures', () => {
    const keys = GALAXY_SECTORS.map((s) => s.key);
    const picks = keys.map((k) => sectorNebula(k));
    const variants = new Set(picks.map((p) => p.variant));
    expect(variants.size).toBe(3);
    // Seeds stay in a small range so most sectors share cached textures.
    for (const p of picks) expect(p.seed).toBeGreaterThanOrEqual(1);
    expect(new Set(picks.map((p) => `${p.variant}:${p.seed}`)).size).toBeLessThanOrEqual(36);
  });

  it('keeps the emission nebula fainter than the others', () => {
    const byVariant = new Map<string, number>();
    for (let i = 0; i < 60; i++) { const n = sectorNebula(`s${i}`); byVariant.set(n.variant, n.alpha); }
    expect(byVariant.get('emission')!).toBeLessThan(byVariant.get('reflection')!);
  });
});
