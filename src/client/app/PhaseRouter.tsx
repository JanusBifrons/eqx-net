/**
 * Per-phase content composition for the App's phase machine.
 *
 * Each phase renders a different shell (AppHeader + body + modal
 * pair). The 'game' phase mounts GameSurface; 'local' mounts the
 * diagnostic LocalSurface; 'meta' is the landing screen; 'auth' is
 * the login flow; 'galaxy-map' (default) is the hex picker, with a
 * transient 'connecting' beat that paints a black background while
 * the global WarpScreen overlay does the show.
 *
 * The Modals (Profile + Settings) appear in every phase shell so the
 * AppHeader's avatar / gear icon work uniformly.
 */

import { Box } from '@mui/material';
import { AppHeader } from '../components/AppHeader';
import { LoginPage } from '../components/LoginPage';
import { ProfileModal } from '../components/ProfileModal';
import { SettingsModal } from '../components/SettingsModal';
import { MetaLandingScreen } from '../components/MetaLandingScreen';
import { LocalSurface } from '../components/LocalSurface';
import { MobileAvatarBadge } from '../layout/MobileAvatarBadge';
import type { AuthUser } from '../../shared-types/auth.js';
import type { Phase } from '../state/storeTypes';

export interface PhaseRouterProps {
  phase: Phase;
  user: AuthUser | null;
  profileOpen: boolean;
  setProfileOpen: (open: boolean) => void;
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
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
  // 'meta' phase deps.
  onJoinFromMeta: () => void;
  onSelectLocal: () => void;
  // 'auth' phase deps.
  onAuthSuccess: () => void;
}

export function PhaseRouter(props: PhaseRouterProps): JSX.Element {
  const {
    phase, user, profileOpen, setProfileOpen, settingsOpen, openSettings, closeSettings,
    setPhase, gameSurface, onJoinFromMeta, onSelectLocal, onAuthSuccess,
  } = props;

  const headerWithLogin = (
    <AppHeader
      onLoginClick={() => setPhase('auth')}
      onProfileClick={() => setProfileOpen(true)}
      onSettingsClick={openSettings}
    />
  );
  const modals = (
    <>
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
    </>
  );

  if (phase === 'game') {
    return (
      <>
        {headerWithLogin}
        {gameSurface}
        {modals}
      </>
    );
  }
  if (phase === 'local') {
    return <LocalSurface />;
  }
  if (phase === 'meta') {
    return (
      <>
        {headerWithLogin}
        <MetaLandingScreen
          onJoin={onJoinFromMeta}
          onSelectLocal={user ? onSelectLocal : undefined}
        />
        <MobileAvatarBadge onClick={() => setProfileOpen(true)} />
        {modals}
      </>
    );
  }
  if (phase === 'auth') {
    return (
      <>
        <AppHeader
          onLoginClick={() => {}}
          onProfileClick={() => setProfileOpen(true)}
          onSettingsClick={openSettings}
        />
        <LoginPage onSuccess={onAuthSuccess} onSkip={onAuthSuccess} />
        {modals}
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
      {modals}
    </>
  );
}
