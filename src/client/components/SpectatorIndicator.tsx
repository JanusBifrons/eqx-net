import { Box } from '@mui/material';
import ExploreIcon from '@mui/icons-material/Explore';
import { selectControlMode, useUIStore } from '../state/store';

/**
 * An on-screen sign that the player is in COMMAND view (RTS slice 10; was
 * "Spectating"): free camera over the fleet, every ship AI-flown. That's where
 * normal play starts, where letting go of the controls lands, and where a
 * destroyed ship drops you. Shown only in command view in-game; the free camera
 * otherwise looks like flying, so without this there's no sign you've let go.
 * Discrete store read (Invariant #2). Tiny + unobtrusive.
 */

const SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
  px: { xs: 0.75, sm: 1 },
  py: { xs: 0.25, sm: 0.4 },
  bgcolor: 'rgba(0,255,136,0.14)',
  border: '1px solid rgba(0,255,136,0.4)',
  borderRadius: 1,
  color: '#7dffc0',
  fontSize: { xs: 10, sm: 12 },
  letterSpacing: 0.6,
  textTransform: 'uppercase' as const,
  fontWeight: 600,
  pointerEvents: 'none' as const,
  userSelect: 'none' as const,
  '& .MuiSvgIcon-root': { fontSize: { xs: 13, sm: 15 } },
} as const;

export function SpectatorIndicator(): JSX.Element | null {
  const phase = useUIStore((s) => s.phase);
  const controlMode = useUIStore(selectControlMode);
  if (phase !== 'game' || controlMode !== 'command') return null;
  return (
    <Box sx={SX} data-testid="spectator-indicator">
      <ExploreIcon />
      Command view
    </Box>
  );
}
