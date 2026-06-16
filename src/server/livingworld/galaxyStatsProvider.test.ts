import { describe, it, expect } from 'vitest';
import {
  buildGalaxySnapshot,
  buildGalaxyPresence,
  type GalaxyStatsProvider,
} from './galaxyStatsProvider.js';
import { GALAXY_SECTORS, getSector } from '../../core/galaxy/galaxy.js';
import {
  GalaxySnapshotResponseSchema,
  type SectorLiveState,
} from '../../shared-types/galaxySnapshot.js';
import { GalaxyPresenceResponseSchema } from '../../shared-types/galaxyPresence.js';

describe('buildGalaxySnapshot', () => {
  it("returns the provider's live sectors verbatim when a provider is set", () => {
    const live: SectorLiveState[] = [
      {
        key: 'sol-prime',
        players: 1,
        enemies: 2,
        neutrals: 3,
        structures: 4,
        owner: { factionId: 'core', contested: false },
      },
    ];
    const provider: GalaxyStatsProvider = {
      galaxySnapshot: () => live,
      playerStructurePresence: () => [],
    };
    expect(buildGalaxySnapshot(provider)).toEqual({ sectors: live });
  });

  it('falls back to the static graph with zero counts when the provider is null', () => {
    const res = buildGalaxySnapshot(null);
    // Every galaxy sector is present, exactly once.
    expect(res.sectors).toHaveLength(GALAXY_SECTORS.length);
    const keys = new Set(res.sectors.map((s) => s.key));
    for (const sec of GALAXY_SECTORS) expect(keys.has(sec.key), `${sec.key} missing`).toBe(true);
    // Zero counts + the static region faction stamped on every sector.
    for (const s of res.sectors) {
      expect(s.players).toBe(0);
      expect(s.enemies).toBe(0);
      expect(s.neutrals).toBe(0);
      expect(s.structures).toBe(0);
      expect(s.owner).toEqual({ factionId: getSector(s.key)!.region, contested: false });
    }
  });

  it('produces output that satisfies the shared zod contract (both paths)', () => {
    expect(() => GalaxySnapshotResponseSchema.parse(buildGalaxySnapshot(null))).not.toThrow();
    const provider: GalaxyStatsProvider = {
      galaxySnapshot: () => [
        { key: 'k', players: 0, enemies: 0, neutrals: 0, structures: 0, owner: null },
      ],
      playerStructurePresence: () => [],
    };
    expect(() => GalaxySnapshotResponseSchema.parse(buildGalaxySnapshot(provider))).not.toThrow();
  });
});

describe('buildGalaxyPresence (Equinox Phase 7)', () => {
  it("returns the provider's per-player owned-structure sectors when a provider is set", () => {
    const provider: GalaxyStatsProvider = {
      galaxySnapshot: () => [],
      playerStructurePresence: (playerId) =>
        playerId === 'p1' ? [{ key: 'sol-prime', structures: 3 }] : [],
    };
    expect(buildGalaxyPresence(provider, 'p1')).toEqual({
      sectors: [{ key: 'sol-prime', structures: 3 }],
    });
    expect(buildGalaxyPresence(provider, 'other')).toEqual({ sectors: [] });
  });

  it('returns no sectors when the provider is null (Living World disabled)', () => {
    expect(buildGalaxyPresence(null, 'p1')).toEqual({ sectors: [] });
  });

  it('produces output that satisfies the shared zod contract (both paths)', () => {
    expect(() => GalaxyPresenceResponseSchema.parse(buildGalaxyPresence(null, 'p1'))).not.toThrow();
    const provider: GalaxyStatsProvider = {
      galaxySnapshot: () => [],
      playerStructurePresence: () => [{ key: 'k', structures: 2 }],
    };
    expect(() => GalaxyPresenceResponseSchema.parse(buildGalaxyPresence(provider, 'p1'))).not.toThrow();
  });
});
