/**
 * App-level hooks lifted out of App.tsx so the App component reads as
 * "configure state -> render phase content" rather than "configure state +
 * side-effects + render phase content".
 *
 *   - `useServerHealthPoll` — drives the galaxy-map health banner + join gate +
 *     hype number. Polls every ~8 s for the whole app lifetime.
 *   - `useShipSwapDispatcher` — orchestrates the `game -> connecting -> game`
 *     phase cycle that powers the GalaxyTab "swap into this hull" CTA. The
 *     200 ms connecting beat is the visible WarpScreen overlay.
 *   - `usePhaseChangeLog` — emits the `phase_change` diagnostic + marks the
 *     transit-instrument `phase_game` t0.
 *   - `useAuthExpiryRedirect` — NO-OP since Living Galaxy P5 (the galaxy map is
 *     the public landing; auth is gated on the sector pick, not on viewing it).
 *   - `useUserPrefsHydration` — applies per-user preferences (settings +
 *     selected ship kind) when auth resolves or the active account changes.
 */

import { useEffect } from 'react';
import { useUIStore } from '../state/store';
import { useAuthStore } from '../auth/authStore';
import { applyUserPrefs } from '../state/store';
import { logEvent } from '../debug/ClientLogger';
import { getGameClient } from '../net/clientSingleton';
import { createServerHealthPoller } from '../net/serverHealthPoller';
import { SERVER_URL } from './serverUrl';

/**
 * Server-health poll loop. Runs for the whole app lifetime — the
 * landing-screen banner + Join-button gate are the primary consumers,
 * but the value also drives the hype-number over the galaxy map (`GalaxyPickerChrome`),
 * so keep polling even after the player joins. The poller is cheap
 * (one HTTP GET every ~8 s in steady state).
 */
export function useServerHealthPoll(): void {
  useEffect(() => {
    const setServerHealth = useUIStore.getState().setServerHealth;
    let lastState: string = useUIStore.getState().serverHealth;
    const poller = createServerHealthPoller({
      url: `${SERVER_URL}/healthz`,
      onChange: (snapshot) => {
        const next = snapshot.state === 'healthy'
          ? (snapshot.data?.ready ? 'healthy' : 'warming')
          : snapshot.state; // 'unreachable' | 'unknown'
        // Log only on transitions so we don't fill the ring buffer
        // with steady-state healthy polls (1 every 8s = 7.5/min).
        if (next !== lastState) {
          logEvent('server_health_change', {
            from: lastState,
            to: next,
            playersOnline: snapshot.data?.playersOnline ?? null,
          });
          lastState = next;
        }
        setServerHealth(next, snapshot.data?.playersOnline ?? null);
      },
    });
    poller.start();
    return () => poller.stop();
  }, []);
}

/**
 * Phase 5 — in-game roster swap. Dispatched by `GalaxyTab` via the
 * Zustand `pendingShipSwap` field; runs a `game → connecting → game`
 * phase cycle so GameSurface unmounts (closing the current room) and
 * remounts cleanly with the new `roomNameOverride` + `joinOptionsOverride`.
 * The 'connecting' beat is what the player sees as the loading spinner.
 * NO transit machinery: no spool-up, no neighbour-only check — the
 * player explicitly picked a hull they own and wants to fly it.
 */
export function useShipSwapDispatcher(
  setRoomNameOverride: (s: string | undefined) => void,
  setJoinOptionsOverride: (o: Record<string, unknown> | undefined) => void,
): void {
  const pendingShipSwap = useUIStore((s) => s.pendingShipSwap);
  const setPendingShipSwap = useUIStore((s) => s.setPendingShipSwap);
  const setCurrentSectorKey = useUIStore((s) => s.setCurrentSectorKey);
  const setPhase = useUIStore((s) => s.setPhase);
  const phase = useUIStore((s) => s.phase);
  useEffect(() => {
    if (!pendingShipSwap) return;
    const { shipId, sectorKey } = pendingShipSwap;
    logEvent('ship_swap_dispatch', { shipId, sectorKey, fromPhase: phase });
    // Update room overrides before the phase flip so when GameSurface
    // remounts it sees the new values immediately.
    setRoomNameOverride(`galaxy-${sectorKey}`);
    // RTS slice 10: "pilot this ship" from the galaxy map lands at the controls.
    setJoinOptionsOverride({ shipId, startMode: 'fly' });
    // Clear the current-sector chrome so the brief galaxy-map glimpse
    // (if any) and post-arrival HUD start from the new sector identity.
    setCurrentSectorKey(null);
    // game → connecting unmounts GameSurface (which cleans up the old
    // Colyseus room). After a microtask the connecting → game flip
    // remounts GameSurface, triggering a fresh joinOrCreate with the
    // shipId override.
    setPhase('connecting');
    const timer = setTimeout(() => {
      setPhase('game');
      setPendingShipSwap(null);
      logEvent('ship_swap_completed', { shipId, sectorKey });
    }, 200);
    return () => clearTimeout(timer);
    // Note: `phase` is intentionally omitted from the deps list — it
    // changes inside this effect (setPhase('connecting' then 'game'))
    // which would re-trigger; the value at dispatch time is sufficient.
  }, [pendingShipSwap, setPhase, setPendingShipSwap, setCurrentSectorKey, setRoomNameOverride, setJoinOptionsOverride]);
}

/**
 * Phase-change diagnostic + transit-instrument t0.
 *
 * For PURE inter-sector transit (the user's warp-out) GameSurface
 * stays mounted and phase never leaves 'game', so the `phase_game`
 * mark is a no-op there (documented expectation). It only emits if a
 * transit-initiated flow also crosses a phase→'game' transition;
 * `mark` itself is a no-op unless an `engage()` t0 is live, so the
 * roster-swap path (which never calls engage) can't produce a
 * spurious row.
 */
export function usePhaseChangeLog(phase: string): void {
  useEffect(() => {
    logEvent('phase_change', { phase });
    if (phase === 'game') getGameClient()?.transitInstr.mark('phase_game');
  }, [phase]);
}

/**
 * NO-OP. The galaxy map is the PUBLIC homepage (auth is gated on "Join the
 * fight" in `GalaxyPickerChrome`, not on viewing the map), so a logged-out or token-expired user must NOT be bumped
 * away from it. Pre-P5 this redirected `!user && phase === 'galaxy-map'` to a splash,
 * which now fights the public map. Kept as a stable call site for a future
 * auth-required phase that might re-introduce an expiry redirect.
 */
export function useAuthExpiryRedirect(): void {
  // Intentionally empty (see above).
}

/**
 * Re-hydrate per-user preferences (settings + selected ship kind)
 * when auth resolves or the active account changes. Anonymous slot is
 * also applied on logout so a stale account's prefs don't leak across.
 */
export function useUserPrefsHydration(): void {
  const { user } = useAuthStore();
  useEffect(() => {
    applyUserPrefs(user?.id ?? null);
  }, [user?.id]);
}
