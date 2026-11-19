/**
 * Abandon one of the pilot's own hulls (moved here from the old roster panel,
 * join flow stage 5). The server breaks the hull up exactly as its death
 * would. A guest is trusted by playerId; an account-bound ship needs that
 * account's Bearer token, sent when signed in. Abandoning the hull this
 * browser is flying ejects to the galaxy map.
 */
import { useCallback } from 'react';
import { useUIStore } from '../../state/store';
import { loadToken } from '../../auth/tokenStorage';
import { forceRefreshRoster } from '../rosterPoller';

export const HANGAR_ABANDON_URL = (shipId: string): string => `/hangar/ships/${encodeURIComponent(shipId)}/abandon`;

export function abandonHeaders(token: string | null): Record<string, string> {
  return token ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json' };
}

export function useAbandonShip(playerId: string): (shipId: string) => Promise<boolean> {
  const setPhase = useUIStore((s) => s.setPhase);
  const setCurrentSectorKey = useUIStore((s) => s.setCurrentSectorKey);
  const localShipInstanceId = useUIStore((s) => s.localShipInstanceId);
  return useCallback(async (shipId: string): Promise<boolean> => {
    // Keyed on the welcome's shipInstanceId, not the server's isActive (which
    // stays true through the reconnect-linger window).
    const wasMyPilotedShip = shipId === localShipInstanceId;
    try {
      const res = await fetch(HANGAR_ABANDON_URL(shipId), {
        method: 'POST',
        headers: abandonHeaders(loadToken()),
        body: JSON.stringify({ playerId }),
      });
      await forceRefreshRoster();
      if (res.ok && wasMyPilotedShip) {
        setCurrentSectorKey(null);
        setPhase('galaxy-map');
      }
      return res.ok;
    } catch {
      return false; // best-effort; the pilot can retry
    }
  }, [playerId, setPhase, setCurrentSectorKey, localShipInstanceId]);
}
