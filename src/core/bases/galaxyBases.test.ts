/**
 * Several NPC bases per galaxy sector (plan soft-leaping-truffle v3, phase T).
 */
import { describe, expect, it } from 'vitest';
import { GALAXY_SECTORS } from '../galaxy/galaxy.js';
import { NPC_STRUCTURES_PER_SECTOR_MAX } from '../../shared-types/structureBudgets.js';
import { baseProfileFor, contextForSector, hashString } from './baseProfile.js';
import { galaxyBasePlan } from './galaxyBases.js';
import { TIER_MAX_STRUCTURES } from './growBase.js';

describe('galaxyBasePlan', () => {
  it("base 0 is exactly the sector's original base (no existing base moves)", () => {
    for (const s of GALAXY_SECTORS) {
      const seed = hashString(s.key);
      const [b0] = galaxyBasePlan(s.key);
      expect(b0!.baseId).toBe('b0');
      expect(b0!.seed).toBe(seed);
      expect(b0!.profile).toEqual(baseProfileFor(contextForSector(s.key), seed));
    }
  });

  it('is deterministic', () => {
    for (const s of GALAXY_SECTORS) expect(galaxyBasePlan(s.key)).toEqual(galaxyBasePlan(s.key));
  });

  it('some sectors hold several bases, never more than three, never two of one role', () => {
    let multi = 0;
    for (const s of GALAXY_SECTORS) {
      const plan = galaxyBasePlan(s.key);
      expect(plan.length).toBeGreaterThanOrEqual(1);
      expect(plan.length).toBeLessThanOrEqual(3);
      expect(new Set(plan.map((b) => b.profile.role)).size, s.key).toBe(plan.length);
      expect(new Set(plan.map((b) => b.baseId)).size).toBe(plan.length);
      if (plan.length > 1) multi++;
    }
    expect(multi, 'several sectors have more than one base').toBeGreaterThanOrEqual(3);
  });

  it('a stronghold or citadel holds its sector alone; extra bases are outposts or settlements', () => {
    for (const s of GALAXY_SECTORS) {
      const plan = galaxyBasePlan(s.key);
      if (plan[0]!.profile.tier === 'stronghold' || plan[0]!.profile.tier === 'citadel') expect(plan.length, s.key).toBe(1);
      for (const b of plan.slice(1)) expect(['outpost', 'settlement'], s.key).toContain(b.profile.tier);
    }
  });

  it('extra bases keep the sector within the NPC structure budget', () => {
    for (const s of GALAXY_SECTORS) {
      const plan = galaxyBasePlan(s.key);
      if (plan.length === 1) continue;
      const total = plan.reduce((n, b) => n + TIER_MAX_STRUCTURES[b.profile.tier], 0);
      expect(total, s.key).toBeLessThanOrEqual(NPC_STRUCTURES_PER_SECTOR_MAX);
    }
  });
});
