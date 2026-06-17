import { getSector } from '../../core/galaxy/galaxy';
import type { SectorFeature } from '../../core/galaxy/galaxy';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import type { RosterEntry } from '../state/storeTypes';

/**
 * Living Galaxy Phase 6 — the content of the galaxy-map sector tooltip, derived
 * from the static graph (name / faction / features — bundled, no wire cost) plus
 * the live snapshot slice (counts / ownership). Pure + unit-tested so the React
 * tooltip stays a thin presenter. There are no raw ids here: `faction` is the
 * readable region label, never a player/entity id (UI-scope rule).
 */
export interface SectorTooltipData {
  name: string;
  /** Readable region/faction label (title-cased), never a raw id. */
  faction: string;
  status: 'Neutral' | 'Held' | 'Contested';
  features: readonly SectorFeature[];
  players: number;
  enemies: number;
  neutrals: number;
  structures: number;
}

/** Title-case a kebab/underscore/space region key for display. */
function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build the tooltip content for `sectorKey`. Returns null for an unknown key.
 * `stats` is the live `/galaxy/snapshot` slice (may be empty before the first
 * poll — counts then read 0 and status is Neutral, which is correct).
 */
export function buildSectorTooltip(
  sectorKey: string,
  stats: readonly SectorLiveState[],
): SectorTooltipData | null {
  const sector = getSector(sectorKey);
  if (!sector) return null;
  let live: SectorLiveState | null = null;
  for (const s of stats) {
    if (s.key === sectorKey) {
      live = s;
      break;
    }
  }
  const status: SectorTooltipData['status'] = live?.owner
    ? live.owner.contested
      ? 'Contested'
      : 'Held'
    : 'Neutral';
  return {
    name: sector.name,
    faction: titleCase(sector.region),
    status,
    features: sector.features,
    players: live?.players ?? 0,
    enemies: live?.enemies ?? 0,
    neutrals: live?.neutrals ?? 0,
    structures: live?.structures ?? 0,
  };
}

/** One of the player's ships in a sector — the galaxy popover's clickable
 *  sub-list (Equinox Phase 7 / Item 4). `kind` is a ship-kind name (e.g.
 *  "fighter"), never a raw id (UI-scope rule). */
export interface SectorShipEntry {
  shipId: string;
  kind: string;
  isActive: boolean;
  /** Current hull (raw; the drawer card derives a % vs the kind's maxHealth). */
  health: number;
  /** Last-known sector-local position (low-cadence roster poll — NOT per-frame). */
  x: number;
  y: number;
}

/**
 * The logged-in player's ships in `sectorKey`, for the galaxy popover's
 * sub-list (the roster the top-bar panel used to show). The ACTIVE ship is
 * matched against the LIVE `currentSectorKey` — its roster `sectorKey` can be
 * stale across a transit (the server doesn't refresh it on markActive). Pure.
 */
export function shipsInSector(
  roster: readonly RosterEntry[],
  sectorKey: string,
  currentSectorKey: string | null,
): SectorShipEntry[] {
  const out: SectorShipEntry[] = [];
  for (const s of roster) {
    const key = s.isActive && currentSectorKey ? currentSectorKey : s.sectorKey;
    if (key === sectorKey) {
      out.push({ shipId: s.shipId, kind: s.kind, isActive: s.isActive, health: s.health, x: s.x, y: s.y });
    }
  }
  return out;
}
