/**
 * Several NPC bases per galaxy sector (plan soft-leaping-truffle v3, phase T).
 */
import { describe, expect, it } from 'vitest';
import { GALAXY_FACTIONS, GALAXY_SECTORS } from '../galaxy/galaxy.js';
import { regionHeart, sectorController } from '../galaxy/control.js';
import { isNpcFactionId, npcFactionDef } from '../../shared-types/factions.js';
import { NPC_STRUCTURES_PER_SECTOR_MAX } from '../../shared-types/structureBudgets.js';
import { baseProfileFor, contextForSector, hashString } from './baseProfile.js';
import { HEART_SUPER_GUNS, galaxyBasePlan, heartOwner, heartSuperGunFunds } from './galaxyBases.js';
import { TIER_MAX_STRUCTURES, growBase } from './growBase.js';
import { chooseBaseSite, grownExtent, type SiteBox } from './baseSite.js';
import { getSector } from '../galaxy/galaxy.js';
import { HOME_POCKET_HALF_EXTENT, sectorSpace } from '../../shared-types/sectorBounds.js';

describe('galaxy bases fit their sectors (coastal defences grew the bastions)', () => {
  it("every sector's bases find a site in turn, a base gap apart (the room's site rule)", () => {
    for (const s of GALAXY_SECTORS) {
      const hard: SiteBox[] = [];
      for (const b of galaxyBasePlan(s.key)) {
        const e = grownExtent(growBase(b.profile, b.seed, getSector(s.key)!.features).placements);
        const site = chooseBaseSite(e, hard, [], { halfExtent: HOME_POCKET_HALF_EXTENT, margin: 250, step: sectorSpace(250), seed: b.seed });
        expect(site, `${s.key}/${b.baseId} (${b.profile.tier} ${b.profile.role}) fits`).not.toBeNull();
        const gap = sectorSpace(900); // SectorRoom NPC_BASE_GAP
        hard.push({ x: site!.x + (e.x0 + e.x1) / 2, y: site!.y + (e.y0 + e.y1) / 2, hw: (e.x1 - e.x0) / 2 + gap, hh: (e.y1 - e.y0) / 2 + gap });
      }
    }
  });
});

describe('galaxyBasePlan', () => {
  it("base 0 is exactly the sector's original base (no existing base moves)", () => {
    for (const s of GALAXY_SECTORS) {
      const seed = hashString(s.key);
      const [b0] = galaxyBasePlan(s.key);
      expect(b0!.baseId).toBe('b0');
      expect(b0!.seed).toBe(seed);
      // Only the owner (F2), its transit links (v4 H) and — for a big base
      // holding a region heart alone — the region's super-guns with their own
      // funding (coastal defences) are added on top of the original profile.
      const { links: _links, superGuns, territoryLock: _lock, ...rest } = b0!.profile;
      if (superGuns !== undefined) {
        expect(superGuns).toEqual(HEART_SUPER_GUNS);
        expect(regionHeart(s.region)).toBe(s.key);
        rest.wealth -= heartSuperGunFunds();
      }
      expect({ ...rest, ownerFaction: 'traders' }).toEqual(baseProfileFor(contextForSector(s.key), seed));
    }
  });

  it('every region heart mounts one 80 cm siege gun and a 40.6 cm battery (coastal defences)', () => {
    const regions = [...new Set(GALAXY_SECTORS.map((s) => s.region))];
    for (const region of regions) {
      const plan = galaxyBasePlan(regionHeart(region));
      const armed = plan.filter((b) => b.profile.superGuns !== undefined);
      expect(armed, region).toHaveLength(1);
      expect(armed[0]!.profile.superGuns).toEqual(HEART_SUPER_GUNS);
    }
    // Nowhere else.
    for (const s of GALAXY_SECTORS) {
      if (regionHeart(s.region) === s.key) continue;
      expect(galaxyBasePlan(s.key).some((b) => b.profile.superGuns !== undefined), s.key).toBe(false);
    }
  });

  it("every region power's heart builds one Territory Lock, owned by that power (sector control)", () => {
    const regions = [...new Set(GALAXY_SECTORS.map((s) => s.region))];
    let hearts = 0;
    for (const region of regions) {
      const heart = regionHeart(region);
      const plan = galaxyBasePlan(heart);
      const locked = plan.filter((b) => b.profile.territoryLock === true);
      // Every power heart, the Crimson Expanse's (held alone by a big trade
      // hub) included: its heart base is the power's, so it carries the lock.
      hearts++;
      expect(locked, region).toHaveLength(1);
      expect(locked[0]!.profile.ownerFaction, region).toBe(sectorController(heart));
      const kinds = growBase(locked[0]!.profile, locked[0]!.seed, getSector(heart)!.features).placements.map((p) => p.kind);
      expect(kinds.filter((k) => k === 'territory_lock'), region).toHaveLength(1);
    }
    expect(hearts).toBe(regions.length);
    // Nowhere else, held or neutral (the rest of the core included).
    for (const s of GALAXY_SECTORS) {
      if (regionHeart(s.region) === s.key) continue;
      for (const b of galaxyBasePlan(s.key)) {
        expect(b.profile.territoryLock, s.key).toBeUndefined();
        expect(growBase(b.profile, b.seed, s.features).placements.some((p) => p.kind === 'territory_lock'), s.key).toBe(false);
      }
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
      // (A military garrison (v4 M) may be a stronghold beside a small base 0.)
      for (const b of plan.slice(1)) if (b.profile.role !== 'military') expect(['outpost', 'settlement'], s.key).toContain(b.profile.tier);
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
  it('a controlled sector is its power’s; the Traders run its trade and transit hubs, except at its heart', () => {
    let traderHubs = 0;
    for (const s of GALAXY_SECTORS) {
      const controller = sectorController(s.key);
      if (controller === null) continue;
      const heart = regionHeart(s.region) === s.key;
      for (const b of galaxyBasePlan(s.key)) {
        const hub = !heart && (b.profile.role === 'trade' || b.profile.role === 'transit');
        if (hub) traderHubs++;
        expect(b.profile.ownerFaction, s.key).toBe(hub ? 'traders' : controller);
      }
    }
    expect(traderHubs, 'the Traders keep their hubs in the other held sectors').toBeGreaterThan(0);
  });

  it("a power's heart base is always the power's, never the Traders' (owner: hand hub to Crimson)", () => {
    const regions = [...new Set(GALAXY_SECTORS.map((s) => s.region))];
    for (const region of regions) {
      const heart = regionHeart(region);
      const power = sectorController(heart)!;
      expect(heartOwner(heart), region).toBe(power);
      for (const b of galaxyBasePlan(heart)) expect(b.profile.ownerFaction, `${region}/${b.baseId}`).toBe(power);
    }
    // The Crimson Expanse heart: its big trade hub stays a trade-hub stronghold
    // holding the sector alone, with the super-guns — only the owner changed.
    const crimson = galaxyBasePlan(regionHeart('crimson-expanse'));
    expect(crimson).toHaveLength(1);
    const original = baseProfileFor(contextForSector(regionHeart('crimson-expanse')), crimson[0]!.seed);
    expect(crimson[0]!.profile).toMatchObject({ tier: original.tier, role: original.role, ownerFaction: 'crimson-expanse', superGuns: HEART_SUPER_GUNS, territoryLock: true });
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
