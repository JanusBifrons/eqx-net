/**
 * How fast a destroyed structure's pieces part: like a SHIP OF ITS SIZE
 * (structure break-up; capital-destruction.md "Structures"). Owner rule:
 * "pieces act exactly like ship wrecks, break scaled by size".
 *
 * Every wreck's parting numbers are per unit of radius (`WRECK_*_PER_RADIUS`
 * × the profile's scales), but the profile a ship of a given size breaks
 * with changes with its size: every ship up to the biggest sub-capital
 * (robot-nexus, radius 110) parts on the sub-cap profile at ~2 radii/s
 * (nexus ~217 u/s), every capital (radius 1220 up) on the capital profile at
 * ~1/800 of that per radius (destroyer ~3 u/s, battleship ~7 u/s). A
 * structure takes the sub-cap's numbers (`STRUCTURE`), so one 330 u across
 * parted at ~660-950 u/s, rammed its neighbours for 700-1,400 damage and
 * chain-killed the base. Its parting tuning is now × `structurePartScale`:
 *  - 1 up to the biggest sub-cap ship's radius (it parts like a sub-cap);
 *  - `CAPITAL_PARTING_SHARE` from the smallest capital's radius up (like a
 *    capital);
 *  - between the two (no ship is that size) the share runs geometrically
 *    with radius, so the absolute speed runs log-log from the nexus's to the
 *    destroyer's (radius 330: ~30 u/s, radius 520: ~14 u/s).
 * The radii come from the ship catalogue, so a new ship kind moves them.
 * Lock: server/rooms/structureWreckDrift.test.ts (each structure against
 * the ships of its size, through the real death path, in u/s).
 *
 * Read once per structure kind (`structureWreckSource` memoises).
 */
import { SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

/** A capital ship wreck's parting speed per radius as a share of a sub-cap
 *  ship's (measured through `buildWreckPieces`, same blow: capitals
 *  0.0022-0.0027 radii/s, sub-caps 1.9-2.1 radii/s). */
export const CAPITAL_PARTING_SHARE = 1 / 800;

let bounds: { sub: number; cap: number } | null = null;

/** The biggest sub-cap ship's radius and the smallest capital's (catalogue). */
export function shipPartingBounds(): { sub: number; cap: number } {
  if (bounds !== null) return bounds;
  let sub = 0;
  let cap = Infinity;
  for (const k of SHIP_KINDS_LIST) {
    const d = shipTuning(k).destruction;
    if (d === 'subcap') sub = Math.max(sub, k.radius);
    else if (d === 'capital') cap = Math.min(cap, k.radius);
  }
  bounds = { sub, cap };
  return bounds;
}

/** The share of its profile's per-radius parting speed a structure of
 *  `radius` parts at: a ship of that size's (see the file comment). */
export function structurePartScale(radius: number): number {
  const { sub, cap } = shipPartingBounds();
  if (!(radius > sub)) return 1;
  if (radius >= cap) return CAPITAL_PARTING_SHARE;
  const t = Math.log(radius / sub) / Math.log(cap / sub);
  return Math.pow(CAPITAL_PARTING_SHARE, t);
}
