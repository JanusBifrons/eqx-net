import { describe, it, expect } from 'vitest';
import { resolveSectorConfig, listGalaxySectors } from './GalaxyRegistry.js';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';

describe('GalaxyRegistry', () => {
  it('resolves sol-prime to dense asteroids and ZERO boot-seeded drones', () => {
    const cfg = resolveSectorConfig('sol-prime');
    expect(cfg.sectorKey).toBe('sol-prime');
    // drone-warp-in (2026-06-11): galaxy sectors boot NO drones — the
    // LivingWorldDirector's roaming pool materialises them only at entry
    // sectors and hops them inward. A non-zero here would re-introduce
    // magic-appearance drones, so the invariant is asserted literally.
    expect(cfg.droneCount).toBe(0);
    expect(cfg.asteroidConfig.length).toBeGreaterThan(0);
    expect(cfg.maxClients).toBeGreaterThan(0);
  });

  it('resolves cygnus-arm to no asteroids (open void) and zero boot-seeded drones', () => {
    const cfg = resolveSectorConfig('cygnus-arm');
    expect(cfg.asteroidConfig).toEqual([]);
    expect(cfg.droneCount).toBe(0);
  });

  it('throws on unknown key', () => {
    expect(() => resolveSectorConfig('nonexistent')).toThrow(/unknown galaxy sector/);
  });

  it('every galaxy sector key resolves successfully', () => {
    for (const sec of GALAXY_SECTORS) {
      expect(() => resolveSectorConfig(sec.key)).not.toThrow();
    }
  });

  it('listGalaxySectors returns the GALAXY_SECTORS array', () => {
    expect(listGalaxySectors()).toBe(GALAXY_SECTORS);
  });
});
