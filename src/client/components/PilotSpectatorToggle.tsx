import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import FlightIcon from '@mui/icons-material/Flight';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { useUIStore } from '../state/store';
import type { PilotMode } from '../state/storeTypes';

/**
 * Phase 5 — the ALWAYS-VISIBLE Pilot ⇄ Spectate toggle (two joined MUI
 * `ToggleButton`s), the user's explicit ask: "a MUI Toggle Button… two buttons
 * joined together… NOT part of the speed-dial". It replaces the speed-dial
 * `spectator-toggle` action (removed) so the mode is a first-class, always-on
 * control rather than buried in a tap-to-expand menu.
 *
 * `pilotMode` is the single discrete store enum (Invariant #2 — the free-roam
 * camera pose lives in the renderer, never the store). The death→spectator flip
 * still fires in `ColyseusClient.killEntity`; this is the deliberate manual
 * toggle. Gated to `phase==='game'` (a mode toggle is meaningless on the
 * galaxy/connecting screens). Kept tiny per the repo's start-tiny default.
 */

const GROUP_SX = {
  bgcolor: 'rgba(8,12,22,0.6)',
  borderRadius: 1,
  '& .MuiToggleButton-root': {
    px: { xs: 0.75, sm: 1.25 },
    py: { xs: 0.25, sm: 0.5 },
    fontSize: { xs: 10, sm: 12 },
    lineHeight: 1.1,
    color: '#9aa0b4',
    borderColor: 'rgba(255,255,255,0.12)',
    textTransform: 'none' as const,
    gap: 0.5,
  },
  '& .MuiToggleButton-root.Mui-selected': {
    color: '#00ff88',
    bgcolor: 'rgba(0,255,136,0.12)',
  },
  '& .MuiToggleButton-root.Mui-selected:hover': {
    bgcolor: 'rgba(0,255,136,0.18)',
  },
  '& .MuiSvgIcon-root': { fontSize: { xs: 14, sm: 16 }, mr: 0.4 },
} as const;

export function PilotSpectatorToggle(): JSX.Element | null {
  const phase = useUIStore((s) => s.phase);
  const pilotMode = useUIStore((s) => s.pilotMode);
  const setPilotMode = useUIStore((s) => s.setPilotMode);

  // A free-roam construction camera only makes sense in-game.
  if (phase !== 'game') return null;

  const onChange = (_e: React.MouseEvent<HTMLElement>, next: PilotMode | null): void => {
    // `exclusive` groups emit null when the active button is re-clicked; ignore
    // that so the toggle never lands in an undefined mode.
    if (next !== null) setPilotMode(next);
  };

  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={pilotMode}
      onChange={onChange}
      aria-label="Pilot or spectate"
      data-testid="pilot-spectator-toggle"
      sx={GROUP_SX}
    >
      <ToggleButton value="pilot" data-testid="pilot-toggle" aria-label="Pilot ship">
        <FlightIcon />
        Pilot
      </ToggleButton>
      <ToggleButton value="spectator" data-testid="spectator-toggle" aria-label="Spectate">
        <VisibilityIcon />
        Spectate
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
