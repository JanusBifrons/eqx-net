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
import { AvatarMenu } from './AvatarMenu.js';

interface Props {
  onLoginClick: () => void;
  onProfileClick: () => void;
  onSettingsClick: () => void;
}

export function AppHeader({ onLoginClick, onProfileClick, onSettingsClick }: Props) {
  const { user } = useAuthStore();

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
        background: 'rgba(5, 7, 15, 0.85)',
        backdropFilter: 'blur(4px)',
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
              onClick={onSettingsClick}
              aria-label="Open settings"
              data-testid="settings-button"
              sx={{ color: 'rgba(255,255,255,0.7)', '&:hover': { color: '#fff' } }}
            >
              <SettingsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {user ? (
            <AvatarMenu onProfileClick={onProfileClick} />
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
