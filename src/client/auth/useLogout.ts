import { useCallback } from 'react';
import { useAuthStore } from './authStore.js';
import { useUIStore } from '../state/store.js';

/**
 * The single logout ownership site (Invariant #12: one ownership site per
 * state surface). Every logout entry point — the avatar context menu
 * (`AvatarMenu`) and the drawer Profile tab (`ProfileTab`) — routes through
 * this hook so the sequence can never drift between surfaces.
 *
 * The sequence, lifted from the original `ProfileTab.onConfirmLogout`:
 *   1. `clearAuth()`     — nulls token+user in Zustand AND clears the
 *                          `eqxAuthToken` localStorage key.
 *   2. `setPhase('meta')`— unmounts `GameSurface` (which disposes the Colyseus
 *                          client + leaves the room) and returns to the main
 *                          menu. The App's passive `!user` redirect only catches
 *                          the galaxy-map phase, so logout must drive the phase
 *                          transition itself.
 *   3. `setDrawerOpen(false)` — closes the drawer if open; a harmless no-op on
 *                          surfaces (header / mobile badge) that have no drawer.
 */
export function useLogout(): () => void {
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const setPhase = useUIStore((s) => s.setPhase);
  const setDrawerOpen = useUIStore((s) => s.setDrawerOpen);

  return useCallback(() => {
    clearAuth();
    setPhase('meta');
    setDrawerOpen(false);
  }, [clearAuth, setPhase, setDrawerOpen]);
}
