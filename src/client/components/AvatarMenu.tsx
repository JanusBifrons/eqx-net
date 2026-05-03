import React, { useState, useRef } from 'react';
import Avatar from '@mui/material/Avatar';
import Popover from '@mui/material/Popover';
import MenuList from '@mui/material/MenuList';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Box from '@mui/material/Box';
import { useAuthStore } from '../auth/authStore.js';

interface Props {
  onProfileClick: () => void;
}

function initials(user: { displayName: string | null; email: string }): string {
  const name = user.displayName ?? user.email;
  return name.slice(0, 2).toUpperCase();
}

export function AvatarMenu({ onProfileClick }: Props) {
  const { user, clearAuth } = useAuthStore();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const avatarRef = useRef<HTMLDivElement>(null);

  if (!user) return null;

  const open = Boolean(anchorEl);

  return (
    <>
      <Avatar
        ref={avatarRef}
        sx={{ width: 32, height: 32, fontSize: 13, cursor: 'pointer', bgcolor: 'primary.main', color: '#000' }}
        onClick={(e) => setAnchorEl(e.currentTarget)}
        title={user.displayName ?? user.email}
      >
        {initials(user)}
      </Avatar>
      <Popover
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
          <MenuItem onClick={() => { setAnchorEl(null); onProfileClick(); }}>
            <ListItemText>Profile</ListItemText>
          </MenuItem>
          <MenuItem onClick={() => { setAnchorEl(null); clearAuth(); }}>
            <ListItemText>Logout</ListItemText>
          </MenuItem>
        </MenuList>
      </Popover>
    </>
  );
}
