/**
 * Warp-to destinations (wrap-up plan W1a, Phase 4 solar-system sectors): the
 * pockets of the pilot's sector as the picker shows them: a name, distance
 * from the ship, whether the ship is already there, and the drop point on the
 * pocket's rim (what `ColyseusClient.requestWarp` takes; the server accepts
 * only a pocket rim). Pure; called a few times a second while the picker is
 * open, never per frame.
 */
import { getSector } from '../../core/galaxy/galaxy.js';
import { pocketPadPair, sectorSites, warpDropPoint, type SectorSite, type SiteKind } from '../../core/galaxy/sectorSites.js';

export interface WarpDestination {
  id: string;
  kind: SiteKind;
  label: string;
  /** Pocket centre and radius (game space), for the system map. */
  x: number;
  y: number;
  r: number;
  /** From the ship to the drop point, km (1 km = 1,000 u). */
  distKm: number;
  /** Where the ship drops out: the rim on the side facing it. */
  dropX: number;
  dropY: number;
  /** The ship is in this pocket already. */
  here: boolean;
  /** Far enough to list under "Far" (EVE-style grouping). */
  far: boolean;
  /** This pocket has a transit pad to another (its label): instant and
   *  free, an alternative to warping. Null when it has none. */
  padTo: string | null;
}

/** Distance (km) beyond which a destination is listed under "Far". */
export const WARP_FAR_KM = 100;

/** The player-facing name of a pocket. */
export function siteLabel(site: SectorSite, beltIndex: number, beltCount: number): string {
  switch (site.kind) {
    case 'home': return 'Home';
    case 'gate': return `${(site.neighbour && getSector(site.neighbour)?.name) || 'Next system'} gate`;
    case 'belt': return beltCount > 1 ? `Asteroid belt ${beltIndex + 1}` : 'Asteroid belt';
    case 'base': return 'Outer base';
    case 'combat': return 'Battle zone';
  }
}

/** The sector's pockets as warp destinations from (x, y), nearest first. */
export function warpDestinations(sectorKey: string, x: number, y: number): WarpDestination[] {
  const sites = sectorSites(sectorKey);
  const belts = sites.filter((s) => s.kind === 'belt');
  const label = (s: SectorSite): string => siteLabel(s, belts.indexOf(s), belts.length);
  const pads = pocketPadPair(sectorKey);
  const out: WarpDestination[] = [];
  for (const s of sites) {
    const drop = warpDropPoint(s, x, y);
    const centre = Math.hypot(x - s.x, y - s.y);
    const here = centre <= s.r * 1.2;
    const distKm = here ? 0 : Math.hypot(drop.x - x, drop.y - y) / 1000;
    out.push({
      id: s.id, kind: s.kind, label: label(s),
      x: s.x, y: s.y, r: s.r, distKm, dropX: drop.x, dropY: drop.y, here, far: distKm > WARP_FAR_KM,
      padTo: pads === null ? null : pads.a.id === s.id ? label(pads.b) : pads.b.id === s.id ? label(pads.a) : null,
    });
  }
  out.sort((a, b) => a.distKm - b.distKm);
  return out;
}

/** "12 km", "140 km", "<1 km". */
export function formatKm(km: number): string {
  return km < 1 ? '<1 km' : `${Math.round(km)} km`;
}
