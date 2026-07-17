/**
 * Campaign 4.4 (anti-patterns review A15 / Part D #13) — `resolveSectorOwner`
 * derives ownership from the LIVE `/galaxy/snapshot` state instead of the v1
 * "everything is NEUTRAL" stub.
 *
 * The seam was signposted from day one ("pass the live state in via
 * `liveStateByKey` and return `st.owner.factionId`") but the body ignored the
 * arg, so the whole galaxy always grouped into ONE neutral territory no matter
 * who owned what — the map could never show two owners as two territories.
 */
import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS } from '../../../core/galaxy/galaxy.js';
import type { SectorLiveState } from '../../../shared-types/galaxySnapshot.js';
import { computeTerritories } from './galaxyTerritories.js';
import { resolveSectorOwner, NEUTRAL_OWNER } from './sectorOwnership.js';

function liveState(key: string, factionId: string | null): SectorLiveState {
  return {
    key,
    players: 0,
    enemies: 0,
    neutrals: 0,
    structures: 0,
    owner: factionId === null ? null : { factionId, contested: false },
  };
}

describe('resolveSectorOwner — live-state-derived ownership (campaign 4.4)', () => {
  it('returns the live owner factionId when the snapshot has one (failed pre-fix: always NEUTRAL)', () => {
    const live = new Map<string, SectorLiveState>([['sol-prime', liveState('sol-prime', 'alice')]]);
    expect(resolveSectorOwner('sol-prime', live)).toBe('alice');
  });

  it('falls back to NEUTRAL for a null owner, a missing sector, or no live state at all', () => {
    const live = new Map<string, SectorLiveState>([['sol-prime', liveState('sol-prime', null)]]);
    expect(resolveSectorOwner('sol-prime', live)).toBe(NEUTRAL_OWNER);
    expect(resolveSectorOwner('vega-reach', live)).toBe(NEUTRAL_OWNER);
    expect(resolveSectorOwner('sol-prime')).toBe(NEUTRAL_OWNER);
    expect(resolveSectorOwner('sol-prime', null)).toBe(NEUTRAL_OWNER);
  });

  it('a two-owner live map produces MULTIPLE territories through the real computeTerritories', () => {
    // One sector owned by 'alice', the rest unclaimed (NEUTRAL) — the exact
    // "two-owner map ⇒ two territories" review assertion. Pre-fix the resolver
    // ignored the live state, so the whole connected galaxy was ONE territory.
    const live = new Map<string, SectorLiveState>([['sol-prime', liveState('sol-prime', 'alice')]]);
    const territories = computeTerritories(GALAXY_SECTORS, 60, (s) =>
      resolveSectorOwner(s.key, live),
    );
    const owners = new Set(territories.map((t) => t.ownerId));
    expect(owners.has('alice')).toBe(true);
    expect(owners.has(NEUTRAL_OWNER)).toBe(true);
    expect(territories.length).toBeGreaterThanOrEqual(2);
  });
});
