import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy';
import { buildSectorTooltip } from './galaxyTooltip';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot';

const sector = GALAXY_SECTORS[0]!;

describe('buildSectorTooltip (Living Galaxy Phase 6)', () => {
  it('returns null for an unknown sector key', () => {
    expect(buildSectorTooltip('no-such-sector', [])).toBeNull();
  });

  it('falls back to zero counts + Neutral when there is no live slice yet', () => {
    const tip = buildSectorTooltip(sector.key, [])!;
    expect(tip).not.toBeNull();
    expect(tip.name).toBe(sector.name);
    expect(tip.status).toBe('Neutral');
    expect(tip.players).toBe(0);
    expect(tip.enemies).toBe(0);
    expect(tip.neutrals).toBe(0);
    expect(tip.structures).toBe(0);
  });

  it('merges the live counts + Held status from the snapshot slice', () => {
    const stats: SectorLiveState[] = [
      { key: sector.key, players: 2, enemies: 5, neutrals: 1, structures: 3, owner: { factionId: 'core', contested: false } },
    ];
    const tip = buildSectorTooltip(sector.key, stats)!;
    expect(tip.players).toBe(2);
    expect(tip.enemies).toBe(5);
    expect(tip.neutrals).toBe(1);
    expect(tip.structures).toBe(3);
    expect(tip.status).toBe('Held');
  });

  it('reports Contested when the owner is contested', () => {
    const stats: SectorLiveState[] = [
      { key: sector.key, players: 0, enemies: 0, neutrals: 0, structures: 0, owner: { factionId: 'core', contested: true } },
    ];
    expect(buildSectorTooltip(sector.key, stats)!.status).toBe('Contested');
  });

  it('exposes a human-readable faction label, never a raw id (UI-scope rule)', () => {
    const tip = buildSectorTooltip(sector.key, [])!;
    expect(tip.faction.length).toBeGreaterThan(0);
    expect(tip.faction[0]).toBe(tip.faction[0]!.toUpperCase()); // title-cased
    expect(tip.faction).not.toContain('-'); // kebab keys are humanised
  });
});
