import { useEffect, useRef, type RefObject } from 'react';
import type { IRenderer } from '@core/contracts/IRenderer';
import { useUIStore, useGameReady } from './state/store';
import { getGameClient } from './net/clientSingleton';
import { logEvent } from './debug/ClientLogger';

/**
 * Warp / loading orchestration — the App↔renderer glue for the load curtain
 * and the sector-to-sector trip (Phase 4 travel state, plan
 * prancy-squishing-donut; docs/architecture/travel-state.md).
 *
 *  - The curtain covers the FIRST join only. A sector-to-sector trip is the
 *    loading screen itself: from `transit_ready` the store's `travelling` is
 *    true, the pilot keeps the normal view (own ship flying, engines, sky)
 *    while the destination loads, and the curtain never rises.
 *  - The trip ends on the loading→ready edge (the destination is loaded and
 *    the ship has arrived): `travelling` clears and the client stops flying
 *    the ship on its trip heading, so it drops in at its real pose (WarpFx
 *    draws the drop).
 *  - The old shader envelope (`setWarpMode`) and arrival flash
 *    (`triggerWarpIn`) are gone (the user, 2026-11-07: "they're incredibly
 *    expensive and suck"); the build-up and drop are WarpFx sprites driven by
 *    the ship's warp phase.
 */
export function useWarpOrchestration(rendererRef: RefObject<IRenderer | null>): void {
  const gameReady = useGameReady();
  const transitState = useUIStore((s) => s.transitState);
  const travelling = useUIStore((s) => s.travelling);
  const loading = !gameReady
    || transitState === 'IN_TRANSIT'
    || transitState === 'ARRIVED';

  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    const curtain = loading && !travelling;
    if (prevLoadingRef.current !== loading) {
      logEvent('load_curtain_change', { active: curtain, travelling });
    }
    if (prevLoadingRef.current && !loading) {
      // Loading → ready: the trip (if any) is over; the ship drops in.
      if (travelling) {
        getGameClient()?.endTravel();
        useUIStore.getState().setTravelling(false);
      }
      // F-transit-instrument — the arrival "curtain" dropped (the trip
      // ended). No-op unless a transit is in flight.
      getGameClient()?.transitInstr.curtainDown();
    }
    prevLoadingRef.current = loading;
    r.setLoadCurtain(curtain);
  }, [loading, travelling]);
}
