import React, { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useAuthStore } from '../auth/authStore.js';
import { apiUpdateProfile } from '../auth/authApi.js';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ProfileModal({ open, onClose }: Props) {
  const { user, token, setAuth } = useAuthStore();
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDisplayName(user?.displayName ?? '');
  }, [open, user]);

  async function handleSave() {
    if (!token || !user) return;
    const trimmed = displayName.trim();
    if (!trimmed) { setError('Display name cannot be empty'); return; }
    setSaving(true);
    setError(null);
    try {
      const { user: updated } = await apiUpdateProfile(token, trimmed);
      setAuth(token, updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Profile</DialogTitle>
      <DialogContent sx={{ pt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="caption" color="text.secondary">{user?.email}</Typography>
        <TextField
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          inputProps={{ maxLength: 32 }}
          size="small"
          fullWidth
          error={!!error}
          helperText={error ?? undefined}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
