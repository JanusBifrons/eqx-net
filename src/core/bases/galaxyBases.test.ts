/**
 * Several NPC bases per galaxy sector (plan soft-leaping-truffle v3, phase T).
 */
import { describe, expect, it } from 'vitest';
import { GALAXY_FACTIONS, GALAXY_SECTORS } from '../galaxy/galaxy.js';
import { regionHeart, sectorController } from '../galaxy/control.js';
import { isNpcFactionId, npcFactionDef } from '../../shared-types/factions.js';
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
      // Only the owner (F2) is assigned on top of the original profile.
      expect({ ...b0!.profile, ownerFaction: 'traders' }).toEqual(baseProfileFor(contextForSector(s.key), seed));
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

describe('galaxy base owners (v4 F2)', () => {
  it('a controlled sector is its power’s; the Traders run its trade hubs', () => {
    for (const s of GALAXY_SECTORS) {
      const controller = sectorController(s.key);
      if (controller === null) continue;
      for (const b of galaxyBasePlan(s.key)) {
        expect(b.profile.ownerFaction, s.key).toBe(b.profile.role === 'trade' ? 'traders' : controller);
      }
    }
  });

  it('neutral ground is shared by minor factions, powers and the Traders', () => {
    const owners = new Set<string>();
    let minorBases = 0;
    let multiOwnerSectors = 0;
    for (const s of GALAXY_SECTORS) {
      if (sectorController(s.key) !== null) continue;
      const plan = galaxyBasePlan(s.key);
      for (const b of plan) {
        owners.add(b.profile.ownerFaction);
        expect(isNpcFactionId(b.profile.ownerFaction), b.profile.ownerFaction).toBe(true);
        if (npcFactionDef(b.profile.ownerFaction)?.kind === 'minor') {
          minorBases++;
          // A minor faction builds only in its own region.
          expect(npcFactionDef(b.profile.ownerFaction)!.region, s.key).toBe(s.region);
        }
      }
      if (new Set(plan.map((b) => b.profile.ownerFaction)).size > 1) multiOwnerSectors++;
    }
    expect(owners.size, 'many factions build on neutral ground').toBeGreaterThanOrEqual(6);
    expect(minorBases, 'minor factions own bases').toBeGreaterThanOrEqual(5);
    expect(multiOwnerSectors, 'some neutral sectors hold several factions').toBeGreaterThanOrEqual(3);
  });
});

describe('sector control (v4 F2)', () => {
  it('most of the galaxy is neutral; powers hold only their heartland', () => {
    const held = GALAXY_SECTORS.filter((s) => sectorController(s.key) !== null);
    expect(held.length).toBeLessThan(GALAXY_SECTORS.length / 2);
    for (const s of held) expect(sectorController(s.key)).toBe(s.region);
    for (const r of GALAXY_FACTIONS) {
      expect(sectorController(regionHeart(r.id)), r.id).toBe(r.id); // every power holds its heart
    }
    expect(sectorController('not-a-sector')).toBeNull();
  });
});
