import React from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import SettingsIcon from '@mui/icons-material/Settings';
import { useAuthStore } from '../auth/authStore.js';
import { useShowLoadingScreen, useUIStore } from '../state/store.js';
import { openCogProfile, ProfileAvatar } from '../panels/CogProfilePage.js';

interface Props {
  onLoginClick: () => void;
}

/** The gear opens the cog panel's main page (the `rightPanel` flag). */
const openCogSettings = (): void => useUIStore.getState().setDrawerTab('settings');

/** Desktop top bar. The gear and the avatar both open the cog panel (U2-8b). */
export function AppHeader({ onLoginClick }: Props) {
  const { user } = useAuthStore();
  // The join loading screen (sector briefing) owns the screen: no top bar over it.
  const loadingScreen = useShowLoadingScreen();
  if (loadingScreen) return null;

  return (
    <AppBar
      position="fixed"
      elevation={0}
      data-testid="app-header"
      sx={{
        // Hidden on touch devices (`pointer: coarse`). Phones in landscape
        // are 667+ px wide — too wide for a `max-width` breakpoint to catch
        // — so we use the input-mode media query instead. Settings, profile,
        // galaxy actions all live in the AdvancedDrawer on touch.
        display: 'flex',
        '@media (pointer: coarse)': { display: 'none' },
        // NOTE: backdropFilter REMOVED 2026-05-13. Stacked over the
        // Pixi WebGL canvas it forced the GPU compositor to readPixels
        // the underlying frame every paint, producing the "GPU stall
        // due to ReadPixels" warnings + the 3–14 s per-click lag the
        // user reported. The 0.85 alpha gives enough background
        // separation without the filter. See
        // tests/e2e/drawer-galaxy-map-open-close.spec.ts.
        background: 'rgba(5, 7, 15, 0.92)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        zIndex: (theme) => theme.zIndex.drawer + 1,
      }}
    >
      <Toolbar variant="dense" sx={{ minHeight: 48, px: 2 }}>
        <Typography
          variant="h6"
          sx={{ fontWeight: 700, letterSpacing: 3, color: 'primary.main', flexGrow: 1 }}
        >
          EQUINOX
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Tooltip title="Settings">
            <IconButton
              size="small"
              onClick={openCogSettings}
              aria-label="Open settings"
              data-testid="settings-button"
              sx={{ color: 'rgba(255,255,255,0.7)', '&:hover': { color: '#fff' } }}
            >
              <SettingsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {user ? (
            <ProfileAvatar name={user.displayName ?? user.email} size={32} onClick={openCogProfile} data-testid="header-avatar" />
          ) : (
            <Button size="small" variant="outlined" color="primary" onClick={onLoginClick}>
              Login
            </Button>
          )}
        </Box>
      </Toolbar>
    </AppBar>
  );
}
