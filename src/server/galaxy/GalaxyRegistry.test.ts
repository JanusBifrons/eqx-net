import { describe, it, expect } from 'vitest';
import { resolveSectorConfig, listGalaxySectors } from './GalaxyRegistry.js';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';

describe('GalaxyRegistry', () => {
  it('resolves sol-prime to dense asteroids and the configured drone count', () => {
    const cfg = resolveSectorConfig('sol-prime');
    expect(cfg.sectorKey).toBe('sol-prime');
    expect(cfg.droneCount).toBe(8);
    expect(cfg.asteroidConfig.length).toBeGreaterThan(0);
    expect(cfg.maxClients).toBeGreaterThan(0);
  });

  it('resolves cygnus-arm to no asteroids (open void)', () => {
    const cfg = resolveSectorConfig('cygnus-arm');
    expect(cfg.asteroidConfig).toEqual([]);
    expect(cfg.droneCount).toBeGreaterThan(0);
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
