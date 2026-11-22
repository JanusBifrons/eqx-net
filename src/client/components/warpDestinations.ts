/**
 * Warp-to destinations (wrap-up plan W1a, Phase 4 solar-system sectors): the
 * pockets of the pilot's sector as the picker shows them: a name, distance
 * from the ship, whether the ship is already there, the drop point on the
 * pocket's rim, and the warp TARGET (warp route check, slice S3).
 *
 * Owner rule: a warp may not pass through the asteroid field or any structure
 * (`core/galaxy/warpTarget.ts`). The target is the drop point when the line is
 * clear, else the near side of the first obstacle; that point IS the
 * destination: the distance shown is to it and `requestWarp` is sent it. A
 * near side too close to warp to (`reachable` false) stays listed, greyed.
 *
 * Called a few times a second while the picker is open, never per frame. The
 * records and the list are reused between calls (`out`): no allocation per
 * recompute once warm (#14).
 */
import { getSector } from '../../core/galaxy/galaxy.js';
import { pocketPadPair, sectorSites, warpDropPointInto, type SectorSite, type SiteKind } from '../../core/galaxy/sectorSites.js';
import { newWarpTarget, warpTargetFor, type WarpTarget } from '../../core/galaxy/warpTarget.js';
import type { CoarseFieldMap } from '../../core/nav/coarseField.js';
import type { WarpStructureSource } from '../../core/nav/warpLineStop.js';

/** clear: the line to the drop point is clear; near: the target is the near
 *  side of an obstacle; blocked: that near side is too close to warp to. */
export type WarpDestState = 'clear' | 'near' | 'blocked';
/** What stops the line (null when clear). */
export type WarpBlocker = 'field' | 'structure' | null;

export interface WarpDestination {
  id: string;
  kind: SiteKind;
  label: string;
  /** Pocket centre and radius (game space), for the system map. */
  x: number;
  y: number;
  r: number;
  /** From the ship to the warp target, km (1 km = 1,000 u). */
  distKm: number;
  /** Where the ship would drop out with a clear line: the rim on the side
   *  facing it. */
  dropX: number;
  dropY: number;
  /** Where the warp really goes (what `requestWarp` is sent): the drop point,
   *  or the near side of the first obstacle on the line to it. */
  targetX: number;
  targetY: number;
  /** False when the target is too close to warp to: listed greyed, not pickable. */
  reachable: boolean;
  state: WarpDestState;
  blocker: WarpBlocker;
  /** The ship is in this pocket already. */
  here: boolean;
  /** Far enough to list under "Far" (EVE-style grouping). */
  far: boolean;
  /** This pocket has a transit pad to another (its label): instant and
   *  free, an alternative to warping. Null when it has none. */
  padTo: string | null;
}

/** The route check's inputs (`WarpRouteClient`): the sector's field map, its
 *  structures and the hull's stop margin (`warpStopMargin`). */
export interface WarpRouteInputs {
  field: CoarseFieldMap | null;
  structures: WarpStructureSource | null;
  margin: number;
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

/** A sector's pockets with their labels and pad partners, built once per sector. */
interface SectorTable { key: string; sites: SectorSite[]; labels: string[]; padTo: (string | null)[] }
let table: SectorTable | null = null;
function sectorTable(sectorKey: string): SectorTable {
  if (table?.key === sectorKey) return table;
  const sites = sectorSites(sectorKey);
  const belts = sites.filter((s) => s.kind === 'belt');
  const label = (s: SectorSite): string => siteLabel(s, belts.indexOf(s), belts.length);
  const pads = pocketPadPair(sectorKey);
  table = {
    key: sectorKey, sites, labels: sites.map(label),
    padTo: sites.map((s) => (pads === null ? null : pads.a.id === s.id ? label(pads.b) : pads.b.id === s.id ? label(pads.a) : null)),
  };
  return table;
}

function newDestination(): WarpDestination {
  return {
    id: '', kind: 'home', label: '', x: 0, y: 0, r: 0, distKm: 0, dropX: 0, dropY: 0, targetX: 0, targetY: 0,
    reachable: true, state: 'clear', blocker: null, here: false, far: false, padTo: null,
  };
}

const drop = { x: 0, y: 0 };
const target: WarpTarget = newWarpTarget();
const fieldOnly: WarpTarget = newWarpTarget();
const byDist = (a: WarpDestination, b: WarpDestination): number => a.distKm - b.distKm;

/**
 * The sector's pockets as warp destinations from (x, y), nearest first,
 * written into `out` (its records reused). Without `route` every line reads
 * clear (no field, no structures).
 */
export function warpDestinations(
  sectorKey: string, x: number, y: number,
  route: WarpRouteInputs | null = null,
  out: WarpDestination[] = [],
): WarpDestination[] {
  const t = sectorTable(sectorKey);
  const n = t.sites.length;
  for (let i = 0; i < n; i++) {
    const s = t.sites[i]!;
    const d = out[i] ?? (out[i] = newDestination());
    warpDropPointInto(s, x, y, drop);
    const here = Math.hypot(x - s.x, y - s.y) <= s.r * 1.2;
    d.id = s.id; d.kind = s.kind; d.label = t.labels[i]!; d.padTo = t.padTo[i]!;
    d.x = s.x; d.y = s.y; d.r = s.r; d.dropX = drop.x; d.dropY = drop.y; d.here = here;
    d.targetX = drop.x; d.targetY = drop.y; d.reachable = true; d.state = 'clear'; d.blocker = null;
    if (!here && route !== null) {
      warpTargetFor(drop.x, drop.y, x, y, route.field, route.structures, route.margin, target);
      d.targetX = target.x; d.targetY = target.y;
      if (target.blocked) {
        d.reachable = target.reachable;
        d.state = target.reachable ? 'near' : 'blocked';
        d.blocker = blockerOf(drop.x, drop.y, x, y, route);
      }
    }
    d.distKm = here ? 0 : Math.hypot(d.targetX - x, d.targetY - y) / 1000;
    d.far = d.distKm > WARP_FAR_KM;
  }
  out.length = n;
  out.sort(byDist);
  return out;
}

/** What stopped the line in `target`: the field when the field alone stops it
 *  at the same point, else a structure (which it reached first). */
function blockerOf(dx: number, dy: number, x: number, y: number, route: WarpRouteInputs): WarpBlocker {
  if (route.field === null) return 'structure';
  warpTargetFor(dx, dy, x, y, route.field, null, route.margin, fieldOnly);
  return fieldOnly.blocked && fieldOnly.x === target.x && fieldOnly.y === target.y ? 'field' : 'structure';
}

/** The row's sub-label for a near-side or too-close destination, else null. */
export function warpStateLabel(d: WarpDestination): string | null {
  if (d.state === 'blocked') return "can't warp there · too close";
  if (d.state === 'near') return d.blocker === 'field' ? 'near side · asteroid field in the way' : 'near side · structure in the way';
  return null;
}

/** "12 km", "140 km", "<1 km". */
export function formatKm(km: number): string {
  return km < 1 ? '<1 km' : `${Math.round(km)} km`;
}
