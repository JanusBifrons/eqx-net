/**
 * Join flow stage 7 — Quick launch: which sector the map's one-tap button
 * sends a pilot to. Pure; reads the same `/galaxy/snapshot` feed the map
 * draws, and the map's own hot-front rule (`HOT_THREAT`), so the button
 * always picks a hex the map is pulsing when one exists.
 */
import { getSector } from '../../core/galaxy/galaxy';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot';
import { HOT_THREAT } from '../render/galaxy/galaxyMapMotion';
import { DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds';

/** The hull Quick launch flies: the free starter Fighter. */
export const QUICK_LAUNCH_KIND = DEFAULT_SHIP_KIND;

/** Ranks a sector for Quick launch: hot front first, then the higher threat,
 *  then recent fighting, then the most pilots, then the most hostiles (a
 *  calm galaxy sends a newcomer where people are, not into the biggest drone
 *  swarm). */
function rank(s: SectorLiveState): [number, number, number, number, number] {
  const threat = s.control?.threat ?? 0;
  return [threat >= HOT_THREAT ? 1 : 0, threat, s.recentCombat != null ? 1 : 0, s.players, s.enemies];
}

/** a ranks above b (lexicographic). */
function above(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** The busiest contested sector in the feed (ties keep feed order), or null
 *  before the first poll. A calm galaxy still gives its busiest sector. */
export function quickLaunchSector(stats: readonly SectorLiveState[]): string | null {
  let best: SectorLiveState | null = null;
  let bestRank: readonly number[] | null = null;
  for (const s of stats) {
    if (!getSector(s.key)) continue;
    const r = rank(s);
    if (bestRank === null || above(r, bestRank)) {
      best = s;
      bestRank = r;
    }
  }
  return best?.key ?? null;
}
