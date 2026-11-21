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

/** Ranks a sector for Quick launch: SAFETY first — no hostiles, else the
 *  fewest — because a fresh launch carries the once-per-account starter
 *  crate (packed Capital) and a newcomer starts in Command view with the
 *  Fighter parked; dropped among robots it is shot within seconds and the
 *  crate is lost for good. Then, among equally safe sectors: hot front, the
 *  higher threat, recent fighting, the most pilots. */
function rank(s: SectorLiveState): [number, number, number, number, number, number] {
  const threat = s.control?.threat ?? 0;
  return [s.enemies === 0 ? 1 : 0, -s.enemies, threat >= HOT_THREAT ? 1 : 0, threat, s.recentCombat != null ? 1 : 0, s.players];
}

/** a ranks above b (lexicographic). */
function above(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** The safest sector in the feed (no hostiles, else the fewest), busiest
 *  among equals (ties keep feed order), or null before the first poll. */
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
