import { useEffect, useRef, type RefObject } from 'react';
import type { IRenderer } from '@core/contracts/IRenderer';
import { useUIStore, useGameReady } from './state/store';
import { getGameClient } from './net/clientSingleton';
import { logEvent } from './debug/ClientLogger';

/**
 * Warp visual orchestration — the App↔renderer glue for the load
 * curtain, the spool→climax+burst envelope, and the single arrival
 * flash. Extracted **verbatim** from `GameSurface` (App.tsx) so the
 * call-ordering invariant is unit-lockable (Phase G,
 * `App.warpOrchestration.test.tsx`); behaviour is identical to the
 * prior inline effects.
 *
 * Three orthogonal decisions, each owning one renderer call:
 *   1. `setLoadCurtain` — opaque overlay during the join + transit
 *      load periods. The "loading screen" itself.
 *   2. `setWarpMode` — the spool→climax+burst+flash envelope. Fires
 *      only during the source-side transit SPOOLING phase; never on
 *      initial join. `setWarpMode(false)` runs the renderer's internal
 *      fade-out + burst when SPOOLING ends (commit → IN_TRANSIT, or
 *      cancel → DOCKED).
 *   3. `triggerWarpIn` — the arrival flash, fired once on the
 *      loading→ready edge.
 *
 * The 4th piece (remote-player warp visuals via `pendingWarpEvents`)
 * is driven by `ColyseusClient` directly — see the per-frame mirror
 * drain in `PixiRenderer.update`.
 *
 * Phase-G coupling (why the ordering matters): a committed inter-sector
 * transit re-arms `gameReady→false` at `transit_ready` (see
 * `rearmJoinReadiness`), so `loading` (= `!gameReady || IN_TRANSIT ||
 * ARRIVED`) flips true **at `transit_ready`** — the curtain rises
 * BEFORE the IN_TRANSIT spool-exit `setWarpMode(false)` burst, giving
 * its ~200 ms tween the whole room-swap window to finish, so the burst
 * fires under an opaque curtain and the player sees only the single
 * arrival-reveal flash. Pre-Phase-G `gameReady` stayed stuck-true, so
 * the first `setLoadCurtain(true)` only coincided with the IN_TRANSIT
 * burst (curtain barely started) → the burst was visible → "double
 * arrival flash". Bug A was a consequence of Bug B; this hook's call
 * sequence is what locks the fixed ordering.
 *
 * `GameSurface` only mounts when `phase === 'game'`, so the pre-`game`
 * connecting period is covered by the App-level `<WarpScreen>` overlay,
 * not by the renderer's curtain (the renderer doesn't exist yet then).
 */
export function useWarpOrchestration(rendererRef: RefObject<IRenderer | null>): void {
  const gameReady = useGameReady();
  const transitState = useUIStore((s) => s.transitState);
  const loading = !gameReady
    || transitState === 'IN_TRANSIT'
    || transitState === 'ARRIVED';

  // 1 + 3. Curtain + arrival-flash combined effect. They share the
  // `loading` derived value, so co-locating avoids drift.
  // `prevLoadingRef` starts false so the first run (loading=true on
  // initial mount) detects a transition and logs the curtain rise —
  // otherwise the log only captures the fall, and E2E coverage of
  // the orchestration is half-blind.
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (prevLoadingRef.current !== loading) {
      logEvent('load_curtain_change', { active: loading });
    }
    if (prevLoadingRef.current && !loading) {
      // Transition from loading → ready — arrival reveal. Anchor to the
      // local ship ENTITY: the renderer tracks that sprite live every
      // frame, so the flash+ripple stays on the ship as it starts
      // moving post-arrival (and never anchors to a stale pre-reconcile
      // pose). `null` → screen-centre fallback if the id isn't known
      // yet (renderer also falls back if the sprite isn't up).
      const localId = getGameClient()?.mirror.localPlayerId ?? null;
      r.triggerWarpIn(localId ? { kind: 'entity', entityId: localId } : null);
      // F-transit-instrument — the arrival curtain dropped. No-op
      // unless a transit is in flight (so the initial-join reveal,
      // which also hits this branch, is correctly ignored) and
      // idempotent per transit. Arms the bounded post-reveal frame
      // burst driven from the rAF loop.
      getGameClient()?.transitInstr.curtainDown();
    }
    prevLoadingRef.current = loading;
    r.setLoadCurtain(loading);
  }, [loading]);

  // 2. Warp-mode envelope — spool→climax+burst+flash. Fires only
  // during transit SPOOLING (the source-sector build-up). When
  // SPOOLING ends — either commit (IN_TRANSIT) or cancel back to
  // DOCKED — `setWarpMode(false)` runs the renderer's internal
  // fade-out + burst. The curtain effect above has (post-Phase-G)
  // already raised the curtain at `transit_ready`, so the burst+flash
  // and curtain rise are perceived as a single hand-off.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (transitState === 'SPOOLING') {
      // Anchor to the local ship ENTITY: the renderer re-resolves that
      // sprite's position EVERY frame. The player keeps flying through
      // the ~3.6s spool; a one-shot capture froze the ripple where
      // charging began (2026-05-15 diagnostic: ship moved ~539u away
      // during the spool — "did the effect where I started charging,
      // not where I was"). The same entity mechanism works for remote/
      // bot warps too — no local special-case.
      const localId = getGameClient()?.mirror.localPlayerId ?? null;
      r.setWarpCenter(localId ? { kind: 'entity', entityId: localId } : null);
      logEvent('warp_mode_change', { active: true, trigger: 'transit_spooling' });
      r.setWarpMode(true);
    } else {
      r.setWarpMode(false);
    }
  }, [transitState]);
}
