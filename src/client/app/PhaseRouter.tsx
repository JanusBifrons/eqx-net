/**
 * Per-phase content composition for the App's phase machine.
 *
 * Each phase renders a different shell (AppHeader + body + modal
 * pair). The 'game' phase mounts GameSurface; 'local' mounts the
 * diagnostic LocalSurface; 'auth' is the login flow; 'galaxy-map'
 * (default) is the homepage for every visitor (the hex map), with a
 * transient 'connecting' beat that paints a black background while
 * the global WarpScreen overlay does the show.
 *
 * The cog panel (settings + Profile) is mounted in every phase shell so the
 * AppHeader's avatar / gear icon open it uniformly (U2-8b).
 */

import { Box } from '@mui/material';
import { AppHeader } from '../components/AppHeader';
import { LoginPage } from '../components/LoginPage';
import { LocalSurface } from '../components/LocalSurface';
import { MobileAvatarBadge } from '../layout/MobileAvatarBadge';
import { CogPanel } from '../panels/CogPanel';
import type { Phase } from '../state/storeTypes';

export interface PhaseRouterProps {
  phase: Phase;
  setPhase: (p: Phase) => void;
  /**
   * The shared gameplay/picker canvas. Rendered in BOTH the 'game'
   * phase (where GameSurface is in 'connect' mode) AND the 'galaxy-map'
   * phase (where it's in 'idle' mode, drawing the spawn picker on the
   * same canvas via GalaxyMapLayer's selector mode — single-canvas
   * refactor). The surface mode + spawn callbacks are wired into the
   * element by App.
   */
  gameSurface: JSX.Element;
  // 'auth' phase deps.
  onAuthSuccess: () => void;
  /** "Continue as guest": remember the choice, then back to the map. */
  onContinueAsGuest: () => void;
}

export function PhaseRouter(props: PhaseRouterProps): JSX.Element {
  const {
    phase, setPhase, gameSurface, onAuthSuccess, onContinueAsGuest,
  } = props;

  const headerWithLogin = <AppHeader onLoginClick={() => setPhase('auth')} />;
  const cog = <CogPanel />;

  if (phase === 'game') {
    return (
      <>
        {headerWithLogin}
        {gameSurface}
        {cog}
      </>
    );
  }
  if (phase === 'local') {
    return <LocalSurface />;
  }
  if (phase === 'auth') {
    return (
      <>
        <AppHeader onLoginClick={() => {}} />
        <LoginPage onSuccess={onAuthSuccess} onSkip={onContinueAsGuest} />
        {cog}
      </>
    );
  }
  // 'galaxy-map' (or transient 'connecting') — visual hex galaxy.
  return (
    <>
      {headerWithLogin}
      {phase === 'connecting' ? (
        // Phase === 'connecting' is the brief 200 ms ship-swap window.
        // The visible content is the `<WarpScreen>` mounted globally
        // below (in LayoutProvider) — this branch just renders a
        // black background underneath so the warp streaks have a
        // contrast surface to paint on.
        <Box
          sx={{
            height: '100vh',
            pt: 'var(--app-bar-h, 48px)',
            bgcolor: '#05070f',
          }}
        />
      ) : (
        // 'galaxy-map' — the spawn picker now renders on the SHARED
        // canvas (GameSurface in 'idle' mode draws GalaxyMapLayer's
        // selector and overlays GalaxyPickerChrome). No second Pixi
        // Application. Spawn callbacks are wired into the element by App.
        gameSurface
      )}
      {/* Touch has no AppBar: the avatar pip is the logged-in cue on the
       *  homepage map; a tap opens the cog's Profile page. */}
      {phase === 'galaxy-map' && <MobileAvatarBadge />}
      {cog}
    </>
  );
}
