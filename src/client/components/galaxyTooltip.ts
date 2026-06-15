import { getSector } from '../../core/galaxy/galaxy';
import type { SectorFeature } from '../../core/galaxy/galaxy';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';

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
