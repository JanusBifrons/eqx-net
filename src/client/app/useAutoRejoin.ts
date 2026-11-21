/**
 * Auto-rejoin after a dropped room (phone backgrounded, cell hop).
 *
 * When the room drops mid-game (`connectionStatus` disconnected / error while
 * `phase === 'game'`) and the server answers `/healthz` again with the page
 * visible, rejoin the SAME ship in the SAME sector through the existing
 * ship-swap path (`pendingShipSwap` → `useShipSwapDispatcher` remounts
 * GameSurface with `{ shipId, startMode }`). The server's rebind path picks
 * the lingering hull back up (same playerId), exactly as the manual
 * "Return to menu → Hangar → Resume" did. No new reconnect machinery: a
 * fresh GameSurface mount means a fresh client, so prediction state starts
 * clean (client CLAUDE.md "Sector handoff resets prediction state").
 *
 * Bounded: at most {@link MAX_REJOIN_ATTEMPTS} per drop, spaced
 * {@link REJOIN_RETRY_MS} apart; a `connected` status ends the episode. If
 * every attempt fails, the Lost Connection overlay's countdown takes over as
 * before. No ship (shipless spectator) → no auto-rejoin.
 */
import { useEffect } from 'react';
import { useUIStore, selectControlMode } from '../state/store';
import type { ConnectionStatus, ServerHealth } from '../state/store';
import { getGameClient } from '../net/clientSingleton';
import { logEvent } from '../debug/ClientLogger';

export const MAX_REJOIN_ATTEMPTS = 3;
export const REJOIN_RETRY_MS = 5_000;

export interface RejoinInputs {
  phase: string;
  connectionStatus: ConnectionStatus;
  serverHealth: ServerHealth;
  pageVisible: boolean;
  shipId: string | null;
  sectorKey: string | null;
  attempts: number;
  msSinceLastAttempt: number;
}

export type RejoinDecision = { kind: 'rejoin' } | { kind: 'wait'; ms: number } | { kind: 'none' };

/** Pure: should we fire a rejoin now, later, or not at all? */
export function decideRejoin(i: RejoinInputs): RejoinDecision {
  if (i.phase !== 'game') return { kind: 'none' };
  if (i.connectionStatus !== 'disconnected' && i.connectionStatus !== 'error') return { kind: 'none' };
  if (!i.pageVisible || i.serverHealth !== 'healthy') return { kind: 'none' };
  if (i.shipId === null || i.sectorKey === null) return { kind: 'none' };
  if (i.attempts >= MAX_REJOIN_ATTEMPTS) return { kind: 'none' };
  if (i.attempts > 0 && i.msSinceLastAttempt < REJOIN_RETRY_MS) {
    return { kind: 'wait', ms: REJOIN_RETRY_MS - i.msSinceLastAttempt };
  }
  return { kind: 'rejoin' };
}

/** Mounted once at the App root (next to `useShipSwapDispatcher`). */
export function useAutoRejoin(): void {
  useEffect(() => {
    // Per-drop episode state lives in the closure of this long-lived effect.
    let attempts = 0;
    let lastAttemptAt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // The rejoin target, remembered across attempts: a failed attempt's fresh
    // client never got a welcome, so its mirror / currentSectorKey are empty.
    let target: { shipId: string; sectorKey: string; startMode: 'fly' | 'command' } | null = null;

    const evaluate = (): void => {
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      const s = useUIStore.getState();
      // A live room or a deliberate exit to the map ends the episode.
      if (s.connectionStatus === 'connected' || s.phase === 'galaxy-map') { attempts = 0; target = null; return; }
      if (s.pendingShipSwap !== null) return; // a swap is already in flight
      const shipId = getGameClient()?.mirror.localShipInstanceId ?? target?.shipId ?? null;
      const sectorKey = s.currentSectorKey ?? target?.sectorKey ?? null;
      const now = Date.now(); // real time: networking retry spacing
      const decision = decideRejoin({
        phase: s.phase,
        connectionStatus: s.connectionStatus,
        serverHealth: s.serverHealth,
        pageVisible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
        shipId,
        sectorKey,
        attempts,
        msSinceLastAttempt: now - lastAttemptAt,
      });
      if (decision.kind === 'wait') { retryTimer = setTimeout(evaluate, decision.ms); return; }
      if (decision.kind !== 'rejoin' || shipId === null || sectorKey === null) return;
      // A retry keeps the first attempt's mode (teardown resets pilotMode).
      const startMode = target?.startMode ?? (selectControlMode(s) === 'fly' ? 'fly' : 'command');
      target = { shipId, sectorKey, startMode };
      attempts++;
      lastAttemptAt = now;
      logEvent('auto_rejoin_attempt', { attempt: attempts, sectorKey, startMode, connectionStatus: s.connectionStatus });
      s.setPendingShipSwap({ shipId, sectorKey, startMode });
    };

    const unsub = useUIStore.subscribe((s, prev) => {
      if (s.phase !== prev.phase || s.connectionStatus !== prev.connectionStatus
        || s.serverHealth !== prev.serverHealth) evaluate();
    });
    const onVisibility = (): void => evaluate();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    evaluate();
    return () => {
      unsub();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, []);
}
