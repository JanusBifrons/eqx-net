import { describe, it, expect } from 'vitest';
import { resolveSectorConfig, listGalaxySectors } from './GalaxyRegistry.js';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';
import { HOME_POCKET_HALF_EXTENT, SOLAR_SECTORS } from '../../shared-types/sectorBounds.js';
import { sectorCutField, sectorSites } from '../../core/galaxy/sectorSites.js';
import { SLICED } from '../../core/terrain/fieldLayout.js';

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
    // The authored field is empty; with solar-system sectors on, the only
    // rocks are the belt pocket's, far from the home pocket.
    for (const a of cfg.asteroidConfig) expect(Math.hypot(a.x, a.y)).toBeGreaterThan(HOME_POCKET_HALF_EXTENT * 4);
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

  it('macro terrain F4: an asteroid-marked sector gets its one cut field and no belt rings; others keep the rings', () => {
    for (const sec of GALAXY_SECTORS) {
      const cfg = resolveSectorConfig(sec.key);
      const field = sectorCutField(sec.key, SOLAR_SECTORS);
      expect(cfg.cutField, sec.key).toEqual(field ?? undefined);
      const belts = SOLAR_SECTORS ? sectorSites(sec.key).filter((s) => s.kind === 'belt') : [];
      const ringRocks = cfg.asteroidConfig.filter((a) => belts.some((b) => a.id.startsWith(`${b.id}-`)));
      if (field) expect(ringRocks, `${sec.key}: the field replaces the belt rings`).toEqual([]);
      else if (belts.length > 0) expect(ringRocks.length, `${sec.key}: belt rings`).toBeGreaterThan(0);
    }
    expect(GALAXY_SECTORS.some((s) => resolveSectorConfig(s.key).cutField)).toBe(SOLAR_SECTORS);
  });

  it('macro terrain F4: the home starter rocks stay, and sit in the field’s open core', () => {
    const cfg = resolveSectorConfig('sol-prime');
    expect(cfg.cutField).toBeDefined();
    expect(cfg.asteroidConfig.length).toBeGreaterThan(0);
    const core = SLICED.radius * SLICED.holeShare;
    for (const a of cfg.asteroidConfig) expect(Math.hypot(a.x, a.y) + a.radius, a.id).toBeLessThan(core);
  });

  it('listGalaxySectors returns the GALAXY_SECTORS array', () => {
    expect(listGalaxySectors()).toBe(GALAXY_SECTORS);
  });
});
