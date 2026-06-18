import { useEffect } from 'react';
import { useUIStore } from '../state/store';
import { GalaxySnapshotResponseSchema } from '../../shared-types/galaxySnapshot.js';

/** Galaxy snapshot poll cadence (ms). "Alive via a few-second refresh", not
 *  sub-second — see docs/architecture/living-galaxy.md. */
const POLL_MS = 4000;

/**
 * Polls `GET /galaxy/snapshot` while a galaxy map is on screen and writes the
 * live per-sector counts into the store (discrete, non-spatial → Zustand-purity-
 * clean, #2). The response is zod-validated (never trust the wire, #3 spirit).
 * Consumed by the GalaxyMapLayer count glyphs via the App sync effect. No-op +
 * no timer while `active` is false.
 */
export function useGalaxyStats(active: boolean): void {
  const setGalaxyStats = useUIStore((s) => s.setGalaxyStats);
  const setGalaxyStatsLoaded = useUIStore((s) => s.setGalaxyStatsLoaded);
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch('/galaxy/snapshot');
        if (!res.ok) return;
        const parsed = GalaxySnapshotResponseSchema.safeParse(await res.json());
        if (!cancelled && parsed.success) {
          setGalaxyStats(parsed.data.sectors);
          // First successful poll ⇒ the map's live counts are ready; drop the
          // loading spinner so icons appear WITH the map, not popped-in after (#2).
          setGalaxyStatsLoaded(true);
        }
      } catch {
        /* transient network — ignore; the next interval retries */
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, setGalaxyStats, setGalaxyStatsLoaded]);
}
