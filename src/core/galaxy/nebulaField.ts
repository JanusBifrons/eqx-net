/**
 * Where the galaxy's nebulae are, and how deep in one a point is (plan
 * nebulae-galaxy-regions, N1). Pure, allocation-free per query, shared by
 * every side (the backdrop draws from it; later the lock rules and the gas
 * collectors read the same numbers, invariant #15).
 *
 * Nebulae come from the galaxy map's `nebula` marks. Each mark is one soft
 * cloud centred on its sector; marks next to each other merge into one cloud
 * (the owner's "joined clouds"), so a sector at the edge of a nebula is thick
 * on the side facing its nebula neighbours and thins toward open space.
 * Sectors without a mark are clear (owner: no fly-through cloud there).
 *
 * Galaxy space: every sector's centre sits at its map hex centre, neighbouring
 * centres one sector width apart, game axes (Y up). A point (x, y) inside a
 * sector is at `origin(sector) + (x, y)` in galaxy space.
 *
 * Depletion (owner, concept for future gas extractors): `thin` circles reduce
 * the density round a point, smoothly, and never to zero ("thin but never
 * empty"; an extractor whose yield follows the density gets diminishing
 * returns for free). Nothing stores circles yet.
 */
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';
import { axialToPixel, GALAXY_SECTORS } from './galaxy.js';

/** Distance between neighbouring sector centres in galaxy space. */
export const NEBULA_SECTOR_SPACING = 2 * SECTOR_PLAYABLE_HALF_EXTENT;
/** A mark's cloud is full out to this many sector widths from its centre... */
const CORE = 0.2;
/** ...and gone at this many. A lone mark: full at the centre, about half at
 *  the edges, wisps in the corners; two marks together stay thick between. */
const REACH = 0.85;

/** A thinned patch, sector-local game space. `taken` >= 0: how much has been
 *  drawn out (density there is multiplied by `exp(-taken)` at the centre). */
export interface NebulaThin { x: number; y: number; r: number; taken: number }

const HEX_SIZE = NEBULA_SECTOR_SPACING / Math.sqrt(3);
const origins = new Map<string, { readonly x: number; readonly y: number }>();
const marked = new Set<string>();
for (const s of GALAXY_SECTORS) {
  const p = axialToPixel(s.hex, HEX_SIZE);
  origins.set(s.key, { x: p.x, y: -p.y }); // map pixels are south-down
}
const marks: number[] = [];
for (const s of GALAXY_SECTORS) {
  if (!s.features.includes('nebula')) continue;
  marked.add(s.key);
  const o = origins.get(s.key)!;
  marks.push(o.x, o.y);
}

/** The sector's centre in galaxy space, or undefined off the galaxy (test rooms). */
export function sectorGalaxyOrigin(sectorKey: string): { readonly x: number; readonly y: number } | undefined {
  return origins.get(sectorKey);
}

/** How deep in a nebula galaxy point (gx, gy) is: 0 clear, 1 deep. */
export function galaxyNebula(gx: number, gy: number): number {
  let clear = 1;
  for (let i = 0; i < marks.length; i += 2) {
    const d = Math.hypot(gx - marks[i]!, gy - marks[i + 1]!) / NEBULA_SECTOR_SPACING;
    if (d >= REACH) continue;
    const k = Math.min(1, (REACH - d) / (REACH - CORE));
    clear *= 1 - k * k * (3 - 2 * k);
  }
  return 1 - clear;
}

/** How deep in a nebula sector-local point (x, y) is (game space), after
 *  any thinned patches. 0 in a sector without a nebula mark. */
export function nebulaDensity(sectorKey: string, x: number, y: number, thin?: readonly NebulaThin[]): number {
  if (!marked.has(sectorKey)) return 0;
  const o = origins.get(sectorKey)!;
  let d = galaxyNebula(o.x + x, o.y + y);
  if (thin && d > 0) {
    for (let i = 0; i < thin.length; i++) {
      const c = thin[i]!;
      const r = Math.hypot(x - c.x, y - c.y) / c.r;
      if (r >= 1) continue;
      const k = Math.min(1, (1 - r) / 0.5);
      d *= Math.exp(-c.taken * k * k * (3 - 2 * k));
    }
  }
  return d;
}

const peaks = new Map<string, number>();
/** The deepest the nebula gets anywhere in the sector (0 = no nebula in it).
 *  Sampled once per sector and cached. */
export function sectorNebulaPeak(sectorKey: string): number {
  const hit = peaks.get(sectorKey);
  if (hit !== undefined) return hit;
  let peak = 0;
  const N = 8, h = SECTOR_PLAYABLE_HALF_EXTENT;
  for (let iy = 0; iy <= N; iy++) {
    for (let ix = 0; ix <= N; ix++) peak = Math.max(peak, nebulaDensity(sectorKey, -h + (2 * h * ix) / N, -h + (2 * h * iy) / N));
  }
  peaks.set(sectorKey, peak);
  return peak;
}

/** True when the sector carries a `nebula` mark on the galaxy map. */
export function isNebulaSector(sectorKey: string): boolean {
  return marked.has(sectorKey);
}
