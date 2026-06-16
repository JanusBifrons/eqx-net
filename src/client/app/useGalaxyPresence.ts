import { useEffect } from 'react';
import { useUIStore } from '../state/store';
import { GalaxyPresenceResponseSchema } from '../../shared-types/galaxyPresence.js';

/** Presence poll cadence (ms) — matches the galaxy snapshot poll. */
const POLL_MS = 4000;

/**
 * Polls `GET /galaxy/presence?playerId=` while a galaxy map is on screen and
 * writes the logged-in player's owned-structure count per sector into the store
 * (discrete, non-spatial → Zustand-purity-clean, #2). The response is
 * zod-validated (#3 spirit). Ship locations are NOT fetched here — they come
 * from the client's own roster and are merged in by the App presence-sync
 * effect. No-op + no timer while `active` is false or `playerId` is absent.
 *
 * MUST live under `app/` (not a top-level `src/client/galaxy/` dir) — that URL
 * collides with the `/galaxy` Vite proxy and 404s the module (LESSONS 2026-06-14,
 * the same gotcha as useGalaxyStats).
 */
export function useGalaxyPresence(active: boolean, playerId: string | null): void {
  const setGalaxyOwnedStructures = useUIStore((s) => s.setGalaxyOwnedStructures);
  useEffect(() => {
    if (!active || !playerId) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`/galaxy/presence?playerId=${encodeURIComponent(playerId)}`);
        if (!res.ok) return;
        const parsed = GalaxyPresenceResponseSchema.safeParse(await res.json());
        if (!cancelled && parsed.success) setGalaxyOwnedStructures(parsed.data.sectors);
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
  }, [active, playerId, setGalaxyOwnedStructures]);
}
