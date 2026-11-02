/**
 * Who controls a sector (plan soft-leaping-truffle v4, F2). Pure.
 *
 * Most of the galaxy is neutral ground. A region power controls only its
 * heartland: the Sol Dominion holds the whole (small) core region, and each
 * frontier power holds its region's heart. Every other sector is neutral and
 * holds bases from many factions (minor companies, the Traders, the powers).
 *
 * `region` on a sector stays as geography; control is this function.
 */
import { GALAXY_SECTORS, getSector } from './galaxy.js';

/** The region whose power holds every one of its sectors. */
const WHOLLY_HELD_REGION = 'core';

/** A region's heart: the sector nearest the region's hex centroid. */
export function regionHeart(region: string): string {
  const members = GALAXY_SECTORS.filter((s) => s.region === region);
  const cq = members.reduce((n, s) => n + s.hex.q, 0) / members.length;
  const cr = members.reduce((n, s) => n + s.hex.r, 0) / members.length;
  let best = members[0]!;
  let bestD = Infinity;
  for (const s of members) {
    const d = (s.hex.q - cq) ** 2 + (s.hex.r - cr) ** 2 + (s.hex.q - cq) * (s.hex.r - cr);
    if (d < bestD || (d === bestD && s.key < best.key)) {
      bestD = d;
      best = s;
    }
  }
  return best.key;
}

const CONTROL = new Map<string, string | null>();
for (const s of GALAXY_SECTORS) {
  const held = s.region === WHOLLY_HELD_REGION || regionHeart(s.region) === s.key;
  CONTROL.set(s.key, held ? s.region : null);
}

/** The faction controlling a sector (a region power id), or null when it is
 *  neutral. Unknown keys (test rooms) are neutral. */
export function sectorController(sectorKey: string): string | null {
  return CONTROL.get(sectorKey) ?? null;
}

/** True for neutral ground. */
export function isNeutralSector(sectorKey: string): boolean {
  return getSector(sectorKey) !== undefined && sectorController(sectorKey) === null;
}
