import { Box, Button, Divider, FormControlLabel, Stack, Switch, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import { useUIStore } from '../../../state/store';
import { PushNotificationToggle } from '../../../components/PushNotificationToggle';
import { useState } from 'react';
import { loadArtPreference, loadLightingPreference, loadSpeedFxPreference, saveArtPreference, saveLightingPreference, saveSpeedFxPreference } from '../../../render/art/artMode';
import { defaultLightingPreset, type LightingPreset } from '../../../render/art/lightingSettings';
import { isTouchDevice } from '../../../input/TouchInput';

const LIGHTING_LABELS: ReadonlyArray<[LightingPreset, string]> = [['baked', 'Baked'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
const LIGHTING_GROUP_SX = { mt: 0.5, '& .MuiToggleButton-root': { fontSize: 11, px: 1, py: 0.25 } } as const;

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

  // Graphics: the Machined look (default) or today's flat look. Per device;
  // read when the game loads, so a change applies on the next load.
  const [machinedArt, setMachinedArt] = useState(() => loadArtPreference() !== 'classic');
  const onArtToggle = (on: boolean): void => {
    setMachinedArt(on);
    saveArtPreference(on ? 'machined' : 'classic');
  };

  // Speed effects (dust streaks + a slight zoom-out at speed). On by default.
  const [speedFx, setSpeedFx] = useState(() => loadSpeedFxPreference() !== false);
  const onSpeedFxToggle = (on: boolean): void => {
    setSpeedFx(on);
    saveSpeedFxPreference(on);
  };

  // Lighting: ships and structures lit live on the GPU (GPU-lit art), or the
  // baked look. Shows the device's default until the player picks.
  const [lighting, setLighting] = useState<LightingPreset>(() => loadLightingPreference()
    ?? defaultLightingPreset(isTouchDevice(), (navigator as { deviceMemory?: number }).deviceMemory));
  const onLighting = (p: LightingPreset | null): void => {
    if (!p) return;
    setLighting(p);
    saveLightingPreference(p);
  };

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
          Graphics
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={machinedArt}
              onChange={(e) => onArtToggle(e.target.checked)}
              inputProps={{ 'aria-label': 'Detailed ship and structure art', 'data-testid': 'settings-toggle-machined-art' } as React.InputHTMLAttributes<HTMLInputElement>}
            />
          }
          label={
            <Box>
              <Typography variant="body2">Detailed art</Typography>
              <Typography variant="caption" color="text.secondary">
                Lit, panelled ships and structures. Off: the simple flat look. Applies the next time the game loads.
              </Typography>
            </Box>
          }
        />
        <FormControlLabel
          control={
            <Switch
              checked={speedFx}
              onChange={(e) => onSpeedFxToggle(e.target.checked)}
              inputProps={{ 'aria-label': 'Speed effects', 'data-testid': 'settings-toggle-speed-fx' } as React.InputHTMLAttributes<HTMLInputElement>}
            />
          }
          label={
            <Box>
              <Typography variant="body2">Speed effects</Typography>
              <Typography variant="caption" color="text.secondary">
                Dust streaks past and the view widens a little when you fly fast. Needs detailed art. Applies the next time the game loads.
              </Typography>
            </Box>
          }
        />
        <Box sx={{ mt: 1 }}>
          <Typography variant="body2">Lighting</Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={lighting}
            onChange={(_e, v: LightingPreset | null) => onLighting(v)}
            sx={LIGHTING_GROUP_SX}
            data-testid="settings-lighting"
            data-value={lighting}
          >
            {LIGHTING_LABELS.map(([id, label]) => (
              <ToggleButton key={id} value={id} data-testid={`settings-lighting-${id}`}>{label}</ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            Ships and structures lit live: long shadows, light from engines, weapons and explosions, and less texture memory. Lower levels suit slower devices; Baked is the older look. Needs detailed art. Applies the next time the game loads.
          </Typography>
        </Box>
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
