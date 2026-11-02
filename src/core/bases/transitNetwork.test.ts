/**
 * v4 H — the transit network: one hub per region at a chokepoint, links that
 * are valid and symmetric, both ends of every link grow a teleporter tagged
 * with it, and no sector goes over its NPC structure budget.
 */
import { describe, expect, it } from 'vitest';
import { GALAXY_SECTORS, getSector } from '../galaxy/galaxy.js';
import { galaxyBasePlan, transitNetwork } from './galaxyBases.js';
import { growBase, TIER_MAX_STRUCTURES } from './growBase.js';
import { TRANSIT_HUB_BASE_ID, linkEnds } from './transitNetwork.js';
import { NPC_STRUCTURES_PER_SECTOR_MAX } from '../../shared-types/structureBudgets.js';

describe('transit network (v4 H)', () => {
  const net = transitNetwork();

  it('has one hub per region, in a sector of that region on its border', () => {
    const regions = new Set(GALAXY_SECTORS.map((s) => s.region));
    expect(net.hubs.size).toBe(regions.size);
    for (const [region, key] of net.hubs) {
      const s = getSector(key)!;
      expect(s.region).toBe(region);
      expect(s.neighbours.some((n) => getSector(n)?.region !== region)).toBe(true);
      expect(galaxyBasePlan(key).some((b) => b.baseId === TRANSIT_HUB_BASE_ID && b.profile.role === 'transit')).toBe(true);
    }
  });

  it('every link joins two bases in different sectors, and both ends list it', () => {
    const ids = new Set<string>();
    for (const l of net.links) {
      expect(ids.has(l.id)).toBe(false);
      ids.add(l.id);
      expect(l.a.sector).not.toBe(l.b.sector);
      expect(linkEnds(l.id)!.map((e) => `${e.sector}/${e.baseId}`).sort()).toEqual([`${l.a.sector}/${l.a.baseId}`, `${l.b.sector}/${l.b.baseId}`].sort());
      for (const end of [l.a, l.b]) {
        const base = galaxyBasePlan(end.sector).find((b) => b.baseId === end.baseId);
        expect(base, `${l.id}: ${end.sector}/${end.baseId} exists`).toBeDefined();
        expect(base!.profile.links).toContain(l.id);
      }
    }
    // Every frontier hub reaches the core hub; every hub reaches its region heart.
    const coreHub = net.hubs.get('core')!;
    for (const [region, hub] of net.hubs) {
      if (region === 'core') continue;
      expect(net.links.some((l) => [l.a.sector, l.b.sector].includes(hub) && [l.a.sector, l.b.sector].includes(coreHub))).toBe(true);
    }
  });

  it('both ends grow a teleporter tagged with the link', () => {
    for (const l of net.links) {
      for (const end of [l.a, l.b]) {
        const base = galaxyBasePlan(end.sector).find((b) => b.baseId === end.baseId)!;
        const grown = growBase(base.profile, base.seed, getSector(end.sector)!.features);
        const tagged = grown.placements.filter((p) => p.link === l.id);
        expect(tagged.length, `${l.id} at ${end.sector}`).toBe(1);
        expect(tagged[0]!.kind).toBe('teleporter');
      }
    }
  });

  it('no sector goes over its NPC structure budget', () => {
    for (const s of GALAXY_SECTORS) {
      const used = galaxyBasePlan(s.key).reduce((n, b) => n + TIER_MAX_STRUCTURES[b.profile.tier], 0);
      expect(used, s.key).toBeLessThanOrEqual(NPC_STRUCTURES_PER_SECTOR_MAX);
    }
  });

  it('is deterministic', () => {
    expect(transitNetwork()).toBe(net);
  });
});
