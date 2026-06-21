import { Box } from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { useUIStore } from '../state/store';

/**
 * Phase 5 — an on-screen indicator that the player is in SPECTATOR mode (the
 * user's ask: "we need some visual indicator on the screen"). Shown only while
 * `pilotMode==='spectator'` in-game; the free-roam camera otherwise looks
 * identical to piloting, so without this there's no signal you've detached.
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
  const pilotMode = useUIStore((s) => s.pilotMode);
  if (phase !== 'game' || pilotMode !== 'spectator') return null;
  return (
    <Box sx={SX} data-testid="spectator-indicator">
      <VisibilityIcon />
      Spectating
    </Box>
  );
}
