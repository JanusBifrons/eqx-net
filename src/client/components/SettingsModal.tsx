import React, { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Divider from '@mui/material/Divider';
import { useUIStore } from '../state/store.js';
import { captureDiagnostic } from '../debug/diagCapture.js';

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

  const [note, setNote] = useState('');
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const onCapture = async (): Promise<void> => {
    setCapturing(true);
    setCaptureStatus('Capturing…');
    const stats = (window as unknown as { __eqxClient?: { stats?: Record<string, unknown> } }).__eqxClient?.stats;
    const result = await captureDiagnostic({ note: note || undefined, stats });
    setCapturing(false);
    if (result.ok) {
      setCaptureStatus(`Saved: ${result.filename ?? '(unknown)'}`);
      setNote('');
    } else {
      setCaptureStatus(`Failed: ${result.error ?? 'unknown error'}`);
    }
  };

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

        <Divider sx={{ my: 2 }} />

        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Diagnostic capture
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Snapshots the recent client-side log buffer (~500 entries) plus prediction stats and posts them to the server. Useful when something feels off — capture, then describe.
        </Typography>
        <Stack spacing={1}>
          <TextField
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What just happened? (optional)"
            size="small"
            multiline
            minRows={2}
            inputProps={{ maxLength: 500, 'aria-label': 'Diagnostic note' }}
          />
          <Button
            variant="contained"
            onClick={onCapture}
            disabled={capturing}
            data-testid="diag-capture-button"
          >
            {capturing ? 'Capturing…' : 'Capture diagnostic'}
          </Button>
          {captureStatus && (
            <Typography variant="caption" color="text.secondary" data-testid="diag-capture-status">
              {captureStatus}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
