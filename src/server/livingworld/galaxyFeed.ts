/**
 * Galaxy feed — the ONE shared `/galaxy/snapshot` body every viewer reads (the
 * galaxy map is the site homepage). Built from the director's existing
 * `galaxyStatsCache` (via `buildGalaxySnapshot`, recomputed on its ~1.5 s
 * control tick) plus each sector's live control meter (`liveSectorControl`),
 * serialized once, and memoised for GALAXY_FEED_INTERVAL_MS: every request in
 * the window gets the same bytes, so a CDN can cache it (`max-age` matches).
 *
 * Rebuilt lazily on the first request after the window ends: no timer, nothing
 * on any tick. The window is real time (it is an HTTP cache lifetime).
 */
import { GALAXY_FEED_INTERVAL_MS, type SectorControl, type SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import { buildGalaxySnapshot, getGalaxyStatsProvider, type GalaxyStatsProvider } from './galaxyStatsProvider.js';
import { liveSectorControl } from './RobotTerritory.js';

export interface GalaxyFeedDeps {
  provider: () => GalaxyStatsProvider | null;
  control: (sectorKey: string) => SectorControl | null;
  nowMs: () => number;
}

export class GalaxyFeed {
  private body = '';
  private builtAtMs = -Infinity;
  private builds = 0;

  constructor(private readonly deps: GalaxyFeedDeps) {}

  /** The serialized snapshot; the same string until the window ends. */
  json(): string {
    const now = this.deps.nowMs();
    if (now - this.builtAtMs >= GALAXY_FEED_INTERVAL_MS) {
      this.body = JSON.stringify(this.build());
      this.builtAtMs = now;
      this.builds++;
    }
    return this.body;
  }

  /** Rebuild count (tests). */
  buildCount(): number {
    return this.builds;
  }

  private build(): { sectors: SectorLiveState[] } {
    const { sectors } = buildGalaxySnapshot(this.deps.provider());
    const out: SectorLiveState[] = [];
    for (const s of sectors) {
      const control = this.deps.control(s.key);
      out.push(control ? { ...s, control } : s);
    }
    return { sectors: out };
  }
}

let shared: GalaxyFeed | null = null;

/** The process-wide feed `galaxyRouter` serves. */
export function getGalaxyFeed(): GalaxyFeed {
  shared ??= new GalaxyFeed({
    provider: getGalaxyStatsProvider,
    control: liveSectorControl,
    // eslint-disable-next-line no-restricted-properties -- real time: an HTTP cache lifetime, not game time
    nowMs: () => Date.now(),
  });
  return shared;
}
