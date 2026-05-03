import React from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import { useUIStore } from '../state/store.js';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const showDevOverlay  = useUIStore((s) => s.showDevOverlay);
  const showLogPanel    = useUIStore((s) => s.showLogPanel);
  const showServerGhost = useUIStore((s) => s.showServerGhost);
  const setShowDevOverlay  = useUIStore((s) => s.setShowDevOverlay);
  const setShowLogPanel    = useUIStore((s) => s.setShowLogPanel);
  const setShowServerGhost = useUIStore((s) => s.setShowServerGhost);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Settings</DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Debug overlays
        </Typography>
        <Stack spacing={1}>
          <FormControlLabel
            control={
              <Switch
                checked={showDevOverlay}
                onChange={(e) => setShowDevOverlay(e.target.checked)}
                inputProps={{ 'aria-label': 'Show debug overlay' }}
              />
            }
            label={
              <>
                <Typography variant="body2">Debug overlay</Typography>
                <Typography variant="caption" color="text.secondary">
                  RTT, drift, prediction stats (top-right). Also toggles with Shift+D.
                </Typography>
              </>
            }
          />
          <FormControlLabel
            control={
              <Switch
                checked={showLogPanel}
                onChange={(e) => setShowLogPanel(e.target.checked)}
                inputProps={{ 'aria-label': 'Show server log' }}
              />
            }
            label={
              <>
                <Typography variant="body2">Server log</Typography>
                <Typography variant="caption" color="text.secondary">
                  Recent corrections and snapshot events (bottom-left).
                </Typography>
              </>
            }
          />
          <FormControlLabel
            control={
              <Switch
                checked={showServerGhost}
                onChange={(e) => setShowServerGhost(e.target.checked)}
                inputProps={{ 'aria-label': 'Show server ghost' }}
              />
            }
            label={
              <>
                <Typography variant="body2">Server ghost</Typography>
                <Typography variant="caption" color="text.secondary">
                  Orange diamond showing the server's authoritative ship position.
                </Typography>
              </>
            }
          />
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
          Settings are saved on this device only.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
