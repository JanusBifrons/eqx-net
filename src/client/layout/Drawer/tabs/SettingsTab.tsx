import { Box, Button, Divider, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import { useUIStore } from '../../../state/store';
import { PushNotificationToggle } from '../../../components/PushNotificationToggle';

/**
 * Mobile-drawer Settings tab.
 *
 * Hosts the same debug-overlay toggles as the desktop `SettingsModal`
 * (showDevOverlay / showLogPanel / showServerGhost) and a "Return to menu"
 * button that drops the player back at the meta landing.
 *
 * Diagnostic capture lives in the Debug tab now (separated by intent —
 * settings are preferences, capture is a debug action).
 */
export function SettingsTab(): JSX.Element {
  const showDevOverlay = useUIStore((s) => s.showDevOverlay);
  const showLogPanel = useUIStore((s) => s.showLogPanel);
  const showServerGhost = useUIStore((s) => s.showServerGhost);
  const setShowDevOverlay = useUIStore((s) => s.setShowDevOverlay);
  const setShowLogPanel = useUIStore((s) => s.setShowLogPanel);
  const setShowServerGhost = useUIStore((s) => s.setShowServerGhost);
  const setPhase = useUIStore((s) => s.setPhase);
  const setDrawerOpen = useUIStore((s) => s.setDrawerOpen);

  const onReturnToMenu = (): void => {
    setPhase('meta');
    setDrawerOpen(false);
  };

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="overline" sx={{ color: '#9aa0b4', display: 'block', mb: 1 }}>
          Navigation
        </Typography>
        <Button
          fullWidth
          variant="outlined"
          startIcon={<HomeIcon />}
          onClick={onReturnToMenu}
          data-testid="settings-return-to-menu"
        >
          Return to main menu
        </Button>
        <Typography variant="caption" sx={{ color: '#9aa0b4', display: 'block', mt: 0.5 }}>
          Leaves the current sector and returns to the landing screen.
        </Typography>
      </Box>

      <Divider />

      <Box>
        <Typography variant="overline" sx={{ color: '#9aa0b4', display: 'block', mb: 1 }}>
          Notifications
        </Typography>
        <PushNotificationToggle />
      </Box>

      <Divider />

      <Box>
        <Typography variant="overline" sx={{ color: '#9aa0b4', display: 'block', mb: 1 }}>
          Debug overlays
        </Typography>
        <Stack spacing={1}>
          <FormControlLabel
            control={
              <Switch
                checked={showDevOverlay}
                onChange={(e) => setShowDevOverlay(e.target.checked)}
                inputProps={{ 'aria-label': 'Show debug overlay', 'data-testid': 'settings-toggle-dev-overlay' } as React.InputHTMLAttributes<HTMLInputElement>}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Debug overlay</Typography>
                <Typography variant="caption" color="text.secondary">
                  RTT, drift, prediction stats. Visible inside the Debug tab.
                </Typography>
              </Box>
            }
          />
          <FormControlLabel
            control={
              <Switch
                checked={showLogPanel}
                onChange={(e) => setShowLogPanel(e.target.checked)}
                inputProps={{ 'aria-label': 'Show server log', 'data-testid': 'settings-toggle-log-panel' } as React.InputHTMLAttributes<HTMLInputElement>}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Server log</Typography>
                <Typography variant="caption" color="text.secondary">
                  Recent corrections and snapshots. Visible inside the Debug tab.
                </Typography>
              </Box>
            }
          />
          <FormControlLabel
            control={
              <Switch
                checked={showServerGhost}
                onChange={(e) => setShowServerGhost(e.target.checked)}
                inputProps={{ 'aria-label': 'Show server ghost', 'data-testid': 'settings-toggle-server-ghost' } as React.InputHTMLAttributes<HTMLInputElement>}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Server ghost</Typography>
                <Typography variant="caption" color="text.secondary">
                  Orange diamond showing the server&rsquo;s authoritative ship position.
                </Typography>
              </Box>
            }
          />
        </Stack>
      </Box>
    </Box>
  );
}
