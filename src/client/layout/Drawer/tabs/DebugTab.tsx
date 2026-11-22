import { useState } from 'react';
import { Box, Button, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import { useUIStore } from '../../../state/store';
import { selectDrawerTabShown } from '../../../state/rightPanel';
import { ConnectionDiagnostics } from '../../../components/ConnectionDiagnostics';
import { DevOverlay } from '../../../components/DevOverlay';
import { LogPanel } from '../../../components/LogPanel';
import { captureDiagnostic } from '../../../debug/diagCapture';

/**
 * The cog panel's Developer page (`panels/CogPanel.tsx` drill-down,
 * `drawerTab = 'debug'`): the diagnostic capture, the debug switches (debug
 * overlay, server log, server ghost), ConnectionDiagnostics, DevOverlay and
 * LogPanel. DevOverlay and LogPanel draw only while their switches are on.
 *
 * **Snapshot-rate gate:** returns `null` unless the Developer page is on
 * screen (`selectDrawerTabShown('debug')`). Panels are persistent Drawers whose
 * children stay mounted while closed, and `drawerTab` persists in Zustand;
 * without this gate the snapshot-rate subscriptions inside
 * `ConnectionDiagnostics`, `DevOverlay` and `LogPanel` would fire 17×/s for
 * anyone who opened the page once. See `docs/LESSONS.md` 2026-05-13 §3.
 */
export function DebugTab(): JSX.Element | null {
  // Hooks must be called unconditionally (React rules of hooks); the
  // `useState` slots below are preserved across panel close/open cycles,
  // so a user typing a diagnostic note doesn't lose it if they
  // accidentally close the panel.
  const shown = useUIStore(selectDrawerTabShown('debug'));
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  if (!shown) return null;

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

      <DebugSwitches />
      <ConnectionDiagnostics />
      <DevOverlay />
      <LogPanel />
    </Box>
  );
}

interface SwitchRowProps {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  caption: string;
  aria: string;
  testId: string;
}

function SwitchRow({ checked, onChange, label, caption, aria, testId }: SwitchRowProps): JSX.Element {
  return (
    <FormControlLabel
      control={
        <Switch
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          inputProps={{ 'aria-label': aria, 'data-testid': testId } as React.InputHTMLAttributes<HTMLInputElement>}
        />
      }
      label={
        <Box>
          <Typography variant="body2">{label}</Typography>
          <Typography variant="caption" color="text.secondary">{caption}</Typography>
        </Box>
      }
    />
  );
}

/** The debug switches (the cog panel's Developer page). */
function DebugSwitches(): JSX.Element {
  const showDevOverlay = useUIStore((s) => s.showDevOverlay);
  const showLogPanel = useUIStore((s) => s.showLogPanel);
  const showServerGhost = useUIStore((s) => s.showServerGhost);
  const setShowDevOverlay = useUIStore((s) => s.setShowDevOverlay);
  const setShowLogPanel = useUIStore((s) => s.setShowLogPanel);
  const setShowServerGhost = useUIStore((s) => s.setShowServerGhost);
  return (
    <Stack spacing={1}>
      <SwitchRow checked={showDevOverlay} onChange={setShowDevOverlay} label="Debug overlay" aria="Show debug overlay"
        testId="settings-toggle-dev-overlay" caption="RTT, drift, prediction stats. Shows on this page." />
      <SwitchRow checked={showLogPanel} onChange={setShowLogPanel} label="Server log" aria="Show server log"
        testId="settings-toggle-log-panel" caption="Recent corrections and snapshots. Shows on this page." />
      <SwitchRow checked={showServerGhost} onChange={setShowServerGhost} label="Server ghost" aria="Show server ghost"
        testId="settings-toggle-server-ghost" caption="Orange diamond showing the server’s authoritative ship position." />
    </Stack>
  );
}
