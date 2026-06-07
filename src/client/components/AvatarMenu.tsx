import React, { useState } from 'react';
import Avatar from '@mui/material/Avatar';
import Popover from '@mui/material/Popover';
import MenuList from '@mui/material/MenuList';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import ListItemIcon from '@mui/material/ListItemIcon';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import BadgeIcon from '@mui/icons-material/Badge';
import LogoutIcon from '@mui/icons-material/Logout';
import type { SxProps, Theme } from '@mui/material/styles';
import { useAuthStore } from '../auth/authStore.js';
import { useLogout } from '../auth/useLogout.js';
import { LogoutConfirmDialog } from './LogoutConfirmDialog.js';

type Variant = 'desktop' | 'mobile';

interface Props {
  /** Opens the display-name editor (`ProfileModal`). */
  onProfileClick: () => void;
  /**
   * `desktop` (default) — the small `AppHeader` avatar. `mobile` — the larger
   * glowing badge used on the meta-landing splash where the header is hidden.
   * The trigger styling differs; the popover menu + logout flow are shared.
   */
  variant?: Variant;
}

function initials(user: { displayName: string | null; email: string }): string {
  const name = user.displayName ?? user.email;
  return name.slice(0, 2).toUpperCase();
}

const DESKTOP_AVATAR_SX: SxProps<Theme> = {
  width: 32,
  height: 32,
  fontSize: 13,
  cursor: 'pointer',
  bgcolor: 'primary.main',
  color: '#000',
};

const MOBILE_AVATAR_SX: SxProps<Theme> = {
  width: 34,
  height: 34,
  fontSize: 13,
  cursor: 'pointer',
  bgcolor: 'rgba(0, 255, 136, 0.85)',
  color: '#000',
  border: '1px solid rgba(0, 255, 136, 0.55)',
  boxShadow: '0 0 6px rgba(0, 255, 136, 0.35)',
  fontWeight: 700,
  letterSpacing: 0.5,
};

export function AvatarMenu({ onProfileClick, variant = 'desktop' }: Props) {
  const { user } = useAuthStore();
  const logout = useLogout();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!user) return null;

  const open = Boolean(anchorEl);
  const isMobile = variant === 'mobile';

  const avatar = (
    <Avatar
      data-testid={isMobile ? 'mobile-avatar-badge' : 'avatar-menu-trigger'}
      sx={isMobile ? MOBILE_AVATAR_SX : DESKTOP_AVATAR_SX}
      onClick={(e) => setAnchorEl(e.currentTarget)}
    >
      {initials(user)}
    </Avatar>
  );

  return (
    <>
      <Tooltip title={user.displayName ?? user.email} placement={isMobile ? 'left' : 'bottom'}>
        {avatar}
      </Tooltip>
      <Popover
        data-testid="avatar-menu"
        open={open}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          {user.displayName && (
            <Typography variant="body2" fontWeight={600} noWrap sx={{ maxWidth: 220 }}>
              {user.displayName}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: 220 }}>
            {user.email}
          </Typography>
        </Box>
        <Divider />
        <MenuList dense sx={{ minWidth: 180 }}>
          <MenuItem
            data-testid="avatar-menu-display-name"
            onClick={() => { setAnchorEl(null); onProfileClick(); }}
          >
            <ListItemIcon><BadgeIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Display name</ListItemText>
          </MenuItem>
          <MenuItem
            data-testid="avatar-menu-logout"
            onClick={() => { setAnchorEl(null); setConfirmOpen(true); }}
          >
            <ListItemIcon><LogoutIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Logout</ListItemText>
          </MenuItem>
        </MenuList>
      </Popover>
      <LogoutConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); logout(); }}
        dialogTestId="avatar-logout-confirm-dialog"
        confirmTestId="avatar-logout-confirm-button"
      />
    </>
  );
}
