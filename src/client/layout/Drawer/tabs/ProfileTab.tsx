import { useEffect, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import { useAuthStore } from '../../../auth/authStore';
import { apiUpdateProfile } from '../../../auth/authApi';
import { useUIStore } from '../../../state/store';

function initials(displayName: string | null, email: string | null): string {
  const src = displayName ?? email ?? '?';
  return src.slice(0, 2).toUpperCase();
}

/**
 * Mobile-drawer Profile tab.
 *
 * Logged-in users get an avatar + display-name editor + a prominent red
 * Logout button gated by a confirm dialog. Logged-out users get a small
 * "Sign in" CTA that routes back through the auth phase.
 *
 * Logout fires `clearAuth()` AND `setPhase('meta')` explicitly — the App's
 * passive `!user` useEffect only catches galaxy-map, so the in-game Logout
 * needs to drive the phase transition itself.
 */
export function ProfileTab(): JSX.Element {
  const { user, token, setAuth, clearAuth } = useAuthStore();
  const setPhase = useUIStore((s) => s.setPhase);
  const setDrawerOpen = useUIStore((s) => s.setDrawerOpen);

  const [displayName, setDisplayName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setDisplayName(user?.displayName ?? '');
  }, [user]);

  if (!user) {
    return (
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center', textAlign: 'center' }}>
        <Avatar sx={{ width: 56, height: 56, bgcolor: '#1a1d2a', color: '#888' }}>?</Avatar>
        <Typography variant="body2" sx={{ color: '#9aa0b4' }}>
          You&rsquo;re playing as a guest.
        </Typography>
        <Button
          variant="outlined"
          data-testid="profile-tab-signin"
          onClick={() => { setPhase('auth'); setDrawerOpen(false); }}
          sx={{ color: '#00ff88', borderColor: '#1f7a4d' }}
        >
          Sign in
        </Button>
      </Box>
    );
  }

  const onSaveName = async (): Promise<void> => {
    if (!token) return;
    const trimmed = displayName.trim();
    if (!trimmed) { setNameError('Display name cannot be empty'); return; }
    setSavingName(true);
    setNameError(null);
    try {
      const { user: updated } = await apiUpdateProfile(token, trimmed);
      setAuth(token, updated);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingName(false);
    }
  };

  const onConfirmLogout = (): void => {
    clearAuth();
    setPhase('meta');
    setConfirmOpen(false);
    setDrawerOpen(false);
  };

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Avatar
          sx={{ width: 56, height: 56, bgcolor: 'primary.main', color: '#000', fontSize: 18, fontWeight: 700 }}
        >
          {initials(user.displayName, user.email)}
        </Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="subtitle1" sx={{ color: '#dde', fontWeight: 600 }} noWrap>
            {user.displayName ?? user.email}
          </Typography>
          <Typography variant="caption" sx={{ color: '#9aa0b4', display: 'block' }} noWrap>
            {user.email}
          </Typography>
        </Box>
      </Stack>

      <Box>
        <Typography variant="overline" sx={{ color: '#9aa0b4', display: 'block', mb: 0.5 }}>
          Display name
        </Typography>
        <Stack direction="row" spacing={1}>
          <TextField
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            inputProps={{ maxLength: 32, 'data-testid': 'profile-tab-display-name' }}
            size="small"
            fullWidth
            error={!!nameError}
            helperText={nameError ?? undefined}
            onKeyDown={(e) => { if (e.key === 'Enter') void onSaveName(); }}
          />
          <Button
            variant="outlined"
            onClick={() => void onSaveName()}
            disabled={savingName || displayName.trim() === (user.displayName ?? '')}
            sx={{ whiteSpace: 'nowrap' }}
          >
            {savingName ? 'Saving…' : 'Save'}
          </Button>
        </Stack>
      </Box>

      <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <Button
          fullWidth
          variant="contained"
          color="error"
          startIcon={<LogoutIcon />}
          onClick={() => setConfirmOpen(true)}
          data-testid="profile-tab-logout"
          sx={{ fontWeight: 700 }}
        >
          Log out
        </Button>
      </Box>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" data-testid="logout-confirm-dialog">
        <DialogTitle>Log out of EQX Peri?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Your session will end and you&rsquo;ll return to the main menu.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            onClick={onConfirmLogout}
            data-testid="logout-confirm-button"
            autoFocus
          >
            Log out
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
