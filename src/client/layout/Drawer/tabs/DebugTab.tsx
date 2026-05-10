import { useState } from 'react';
import { Box, Button, Stack, TextField, Typography } from '@mui/material';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import { ConnectionDiagnostics } from '../../../components/ConnectionDiagnostics';
import { DevOverlay } from '../../../components/DevOverlay';
import { LogPanel } from '../../../components/LogPanel';
import { captureDiagnostic } from '../../../debug/diagCapture';

/**
 * Mobile-drawer Debug tab.
 *
 * Hosts the diagnostic surfaces that used to clutter the always-visible
 * HUD: ConnectionDiagnostics + DevOverlay + LogPanel. The latter two are
 * gated by their existing Zustand toggles (`showDevOverlay`, `showLogPanel`)
 * so the user can declutter without leaving the tab.
 *
 * The Capture Diagnostic block (formerly inside `SettingsModal`) lives at
 * the top — it's the most action-oriented thing in this tab.
 *
 * Sticky-bottom positioning of the Debug tab in the rail is handled by
 * `AdvancedDrawer`, not here.
 */
export function DebugTab(): JSX.Element {
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const onCapture = async (): Promise<void> => {
    setCapturing(true);
    setStatus('Capturing…');
    const stats = (window as unknown as { __eqxClient?: { stats?: Record<string, unknown> } }).__eqxClient?.stats;
    const result = await captureDiagnostic({ note: note || undefined, stats });
    setCapturing(false);
    if (result.ok) {
      setStatus(`Saved: ${result.filename ?? '(unknown)'}`);
      setNote('');
    } else {
      setStatus(`Failed: ${result.error ?? 'unknown error'}`);
    }
  };

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="overline" sx={{ color: '#9aa0b4', display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
          <BugReportOutlinedIcon sx={{ fontSize: 14 }} /> Capture diagnostic
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
            onClick={() => void onCapture()}
            disabled={capturing}
            data-testid="diag-capture-button"
          >
            {capturing ? 'Capturing…' : 'Capture diagnostic'}
          </Button>
          {status && (
            <Typography variant="caption" color="text.secondary" data-testid="diag-capture-status">
              {status}
            </Typography>
          )}
        </Stack>
      </Box>

      <ConnectionDiagnostics />
      <DevOverlay />
      <LogPanel />
    </Box>
  );
}
