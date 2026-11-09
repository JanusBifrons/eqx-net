/**
 * v4 M — military bases: where they go, who owns them, and their character
 * (fenced, turret-heavy, every gun on a bastion outside the fence).
 */
import { describe, expect, it } from 'vitest';
import { getSector, isEntrySector } from '../galaxy/galaxy.js';
import { regionHeart, sectorController } from '../galaxy/control.js';
import { MILITARY_BASE_ID, galaxyBasePlan, militarySites } from './galaxyBases.js';
import { TURRET_KINDS, growBase } from './growBase.js';
import { minorFactionsOf } from '../../shared-types/factions.js';
import { structureHalfExtents } from '../../shared-types/structureKinds.js';

// Coastal defences: every gun kind (energy turrets and the gun batteries).
const TURRETS: ReadonlySet<string> = TURRET_KINDS;
const FENCE = new Set(['shield_pylon', 'shield_gate']);
const POWER = new Set(['connector', 'capital', 'solar', 'reactor', 'battery', 'battery_bank']);

describe('military bases (v4 M)', () => {
  const sites = militarySites();

  it('each region heart has a garrison (unless a big base holds it); edges are neutral entry sectors', () => {
    const hearts = [...sites].filter(([, s]) => s === 'heart').map(([k]) => k);
    for (const k of hearts) {
      expect(regionHeart(getSector(k)!.region)).toBe(k);
      const plan = galaxyBasePlan(k);
      const big = plan[0]!.profile.tier === 'stronghold' || plan[0]!.profile.tier === 'citadel';
      expect(plan.some((b) => b.baseId === MILITARY_BASE_ID), k).toBe(!big);
    }
    for (const [k, s] of sites) {
      if (s !== 'edge') continue;
      expect(isEntrySector(k)).toBe(true);
      expect(sectorController(k)).toBeNull();
      expect(galaxyBasePlan(k).some((b) => b.baseId === MILITARY_BASE_ID), k).toBe(true);
    }
  });

  it('a heart garrison is the region power’s; an edge outpost a militia’s (else the power’s)', () => {
    for (const [k, s] of sites) {
      const mil = galaxyBasePlan(k).find((b) => b.baseId === MILITARY_BASE_ID);
      if (mil === undefined) continue;
      expect(mil.profile.role).toBe('military');
      const region = getSector(k)!.region;
      const militia = minorFactionsOf(region).find((m) => m.specialty === 'militia')?.id;
      expect(mil.profile.ownerFaction).toBe(s === 'heart' ? (sectorController(k) ?? region) : (militia ?? region));
    }
  });

  it('is fenced and turret-heavy, with every gun outside the fence', () => {
    for (const [k] of sites) {
      const mil = galaxyBasePlan(k).find((b) => b.baseId === MILITARY_BASE_ID);
      if (mil === undefined) continue;
      expect(mil.profile.fenced).toBe(true);
      const grown = growBase(mil.profile, mil.seed, getSector(k)!.features);
      const guns = grown.placements.filter((p) => TURRETS.has(p.kind));
      // What the base works with: everything but its guns, fence, wiring, power and core.
      const work = grown.placements.filter((p) => !TURRETS.has(p.kind) && !FENCE.has(p.kind) && !POWER.has(p.kind));
      expect(guns.length, k).toBeGreaterThanOrEqual(4);
      expect(guns.length, `${k}: more guns than working structures`).toBeGreaterThan(work.length);
      let fx = 0, fy = 0;
      for (const p of grown.placements) {
        if (!FENCE.has(p.kind)) continue;
        fx = Math.max(fx, Math.abs(p.x));
        fy = Math.max(fy, Math.abs(p.y));
      }
      for (const g of guns) {
        const { hw, hh } = structureHalfExtents(g.kind, g.rot ?? 0);
        const outside = Math.abs(g.x) - hw >= fx || Math.abs(g.y) - hh >= fy;
        expect(outside, `${k}: ${g.kind} at ${g.x},${g.y} is outside the fence`).toBe(true);
      }
    }
  });
});
