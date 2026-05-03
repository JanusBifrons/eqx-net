import React from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import { useAuthStore } from '../auth/authStore.js';
import { AvatarMenu } from './AvatarMenu.js';

interface Props {
  onLoginClick: () => void;
  onProfileClick: () => void;
}

export function AppHeader({ onLoginClick, onProfileClick }: Props) {
  const { user } = useAuthStore();

  return (
    <AppBar
      position="fixed"
      elevation={0}
      sx={{
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
        <Box>
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
