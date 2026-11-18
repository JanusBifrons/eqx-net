/**
 * Do the galaxy NPC bases fit inside the cut-field clearings round them?
 * (structure-restyle: freight docks grew to 1000x400 with a 900x500 landing
 * pad; macro terrain F4 cut a rock-free clearing of
 * `fieldClearingRadius(site)` round every pocket of an asteroid sector.)
 *
 * Pure replay of `SectorRoom.seedGalaxyBase` / `seedOneGalaxyBase` for a
 * fresh world (no saved player structures, no lingering hulls):
 *  - the plans come from `galaxyBasePlan`, grown with `growBase` (what
 *    `NpcBaseSubsystem.grow` does with a profile-carrying spec);
 *  - with solar-system sectors on and two or more bases, the last grows round
 *    the sector's outer `base` pocket, the rest in the home pocket;
 *  - hard boxes: every earlier base's gap box (`NPC_BASE_GAP`) and its
 *    structures; soft circles: the room's swarm asteroids, i.e. the resolved
 *    `asteroidConfig` at their seed positions (cut-field rocks are not
 *    obstacles there);
 *  - `chooseBaseSite` with the room's options, including `within` the
 *    pocket's clearing (`pocketClearing`).
 * Structures the room's `place` would reject are counted in, so the footprint
 * here can only be larger than the real one.
 *
 * The footprint (every structure box and every dock pad, 90-degree rotations
 * so the boxes are exact) must lie inside the clearing the base grew in.
 */
import { describe, expect, it } from 'vitest';
import { GALAXY_SECTORS, getSector } from '../../core/galaxy/galaxy.js';
import { pocketClearing, sectorCutField, sectorSites } from '../../core/galaxy/sectorSites.js';
import { galaxyBasePlan } from '../../core/bases/galaxyBases.js';
import { growBase, type GrownPlacement } from '../../core/bases/growBase.js';
import { chooseBaseSite, grownExtent, type SiteBox, type SiteCircle } from '../../core/bases/baseSite.js';
import { keepClearBox } from '../../core/structures/placementRules.js';
import { structureHalfExtents } from '../../shared-types/structureKinds.js';
import { HOME_POCKET_HALF_EXTENT, SOLAR_SECTORS, sectorSpace } from '../../shared-types/sectorBounds.js';
import { resolveSectorConfig } from './GalaxyRegistry.js';

/** SectorRoom `NPC_BASE_GAP`. */
const NPC_BASE_GAP = sectorSpace(900);

interface Fit {
  sector: string;
  baseId: string;
  tier: string;
  pocket: string;
  /** How far the footprint reaches past the clearing rim (u); <= 0 fits. */
  over: number;
  /** What reaches farthest. */
  what: string;
}

/** Farthest distance of an AABB from a point (one of its corners). */
function farCorner(cx: number, cy: number, x: number, y: number, hw: number, hh: number): number {
  return Math.hypot(Math.abs(x - cx) + hw, Math.abs(y - cy) + hh);
}

function measure(): Fit[] {
  const out: Fit[] = [];
  for (const s of GALAXY_SECTORS) {
    const field = sectorCutField(s.key, SOLAR_SECTORS);
    if (field === null) continue;
    const features = getSector(s.key)!.features;
    const soft: SiteCircle[] = resolveSectorConfig(s.key).asteroidConfig.map((a) => ({ x: a.x, y: a.y, r: a.radius }));
    const plans = galaxyBasePlan(s.key);
    const outer = SOLAR_SECTORS && plans.length >= 2 ? sectorSites(s.key).find((p) => p.kind === 'base') ?? null : null;
    const hard: SiteBox[] = [];
    plans.forEach((plan, i) => {
      const at = outer && i === plans.length - 1 ? { x: outer.x, y: outer.y } : null;
      const grown = growBase(plan.profile, plan.seed, features);
      const ext = grownExtent(grown.placements);
      const within = pocketClearing(s.key, SOLAR_SECTORS, at?.x ?? 0, at?.y ?? 0);
      const site = chooseBaseSite(ext, hard, soft, {
        halfExtent: HOME_POCKET_HALF_EXTENT, margin: 250, step: sectorSpace(250), seed: plan.seed,
        ...(at ? { centreX: at.x, centreY: at.y } : {}),
        ...(within ? { within } : {}),
      });
      expect(site, `${s.key}/${plan.baseId} finds a site`).not.toBeNull();
      const cx = at?.x ?? 0, cy = at?.y ?? 0;
      const clearing = field.clearings.find((c) => c.x === cx && c.y === cy);
      // A pocket outside the field's reach has no rocks round it at all.
      if (clearing !== undefined) {
        let worst = -Infinity, what = '';
        const outs: string[] = [];
        const check = (p: GrownPlacement): void => {
          const { hw, hh } = structureHalfExtents(p.kind, p.rot ?? 0);
          const d = farCorner(cx, cy, site!.x + p.x, site!.y + p.y, hw, hh);
          if (d > worst) { worst = d; what = p.kind; }
          if (d > clearing.r) outs.push(`${p.kind} +${Math.round(d - clearing.r)}`);
          const pad = keepClearBox(p.kind, site!.x + p.x, site!.y + p.y, p.rot ?? 0);
          if (pad !== null) {
            const dp = farCorner(cx, cy, pad.x, pad.y, pad.hw, pad.hh);
            if (dp > worst) { worst = dp; what = `${p.kind} pad`; }
            if (dp > clearing.r) outs.push(`${p.kind} pad +${Math.round(dp - clearing.r)}`);
          }
        };
        for (const p of grown.placements) check(p);
        out.push({
          sector: s.key, baseId: plan.baseId, tier: plan.profile.tier,
          pocket: at ? 'outer base pocket' : 'home', over: Math.round(worst - clearing.r), what, out: outs,
        });
      }
      for (const p of grown.placements) {
        const { hw, hh } = structureHalfExtents(p.kind, p.rot ?? 0);
        hard.push({ x: site!.x + p.x, y: site!.y + p.y, hw, hh });
      }
      hard.push({
        x: site!.x + (ext.x0 + ext.x1) / 2, y: site!.y + (ext.y0 + ext.y1) / 2,
        hw: (ext.x1 - ext.x0) / 2 + NPC_BASE_GAP, hh: (ext.y1 - ext.y0) / 2 + NPC_BASE_GAP,
      });
    });
  }
  return out;
}

const line = (f: Fit): string => `${f.sector}/${f.baseId} (${f.tier}, ${f.pocket}) ${f.over > 0 ? '+' : ''}${f.over}u via ${f.what}`;

describe.runIf(SOLAR_SECTORS)('galaxy bases fit their cut-field clearings', () => {
  it('every home-pocket base lies inside the home clearing', () => {
    const home = measure().filter((f) => f.pocket === 'home');
    expect(home.length).toBeGreaterThan(0);
    expect(home.filter((f) => f.over > 0).map(line)).toEqual([]);
  });

  // The outer base pocket is searched over the home square (corners 6718 u
  // out) but its clearing is 6500 u: without `within`, bases poked up to
  // 218 u into the rock wall (orion-belt/hub, thornfield/b1, tideglass/b1,
  // kepler-spur/hub's dock pad).
  it('every base footprint (structures and dock pads) lies inside its clearing', () => {
    const fits = measure();
    expect(fits.length).toBeGreaterThan(0);
    expect(fits.filter((f) => f.over > 0).map(line)).toEqual([]);
  });
});
