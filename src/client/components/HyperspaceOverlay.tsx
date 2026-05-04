import { Box, Button, LinearProgress, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { getSector } from '../../core/galaxy/galaxy';

interface HyperspaceOverlayProps {
  /** Cancel callback, fired when the player clicks "Abort spool". Wired to
   *  `transitClient.cancelTransit(room)` by App.tsx. */
  onCancel: () => void;
}

/**
 * Phase 8 sub-phase B — full-screen UI overlay during inter-sector transit.
 *
 * Renders nothing while `transitState === 'DOCKED'`. During SPOOLING shows
 * a 0..1 LinearProgress with the destination sector name and an Abort
 * button (vulnerable spool-up: the player can cancel any time before
 * commit, AND the ship can still take damage in the source room — the
 * orchestrator subscribes to SHIP_DESTROYED to abort transit cleanly on
 * death). During IN_TRANSIT shows a warp-streak fade. ARRIVED is a brief
 * green flash; the ColyseusClient's transit_state handler then transitions
 * back to DOCKED.
 *
 * Reads `transitState`, `transitProgress`, `transitTargetSectorKey` from
 * Zustand. No spatial state — purity invariant intact.
 */
export function HyperspaceOverlay({ onCancel }: HyperspaceOverlayProps): JSX.Element | null {
  const transitState     = useUIStore((s) => s.transitState);
  const transitProgress  = useUIStore((s) => s.transitProgress);
  const targetSectorKey  = useUIStore((s) => s.transitTargetSectorKey);

  if (transitState === 'DOCKED') return null;

  const target = targetSectorKey ? getSector(targetSectorKey) : null;
  const targetName = target?.name ?? targetSectorKey ?? '???';

  if (transitState === 'SPOOLING') {
    return (
      <Box
        data-testid="hyperspace-overlay"
        data-transit-state="SPOOLING"
        sx={{
          position: 'fixed',
          top: 'auto',
          bottom: 80,
          left: 16,
          right: 16,
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
          p: 2,
          bgcolor: 'rgba(5,7,15,0.92)',
          border: '1px solid #1f7a4d',
          borderRadius: 2,
          maxWidth: 480,
          mx: 'auto',
        }}
      >
        <Typography variant="overline" sx={{ color: '#00ff88', letterSpacing: 3 }}>
          Spooling Hyperdrive · Destination {targetName}
        </Typography>
        <LinearProgress
          variant="determinate"
          value={transitProgress * 100}
          sx={{
            width: '100%',
            height: 6,
            borderRadius: 3,
            bgcolor: '#0a3322',
            '& .MuiLinearProgress-bar': { bgcolor: '#00ff88' },
          }}
        />
        <Typography variant="caption" sx={{ color: '#9aa0b4' }}>
          Ship remains vulnerable. Disengage with the button below or by losing health.
        </Typography>
        <Button
          variant="outlined"
          size="small"
          onClick={onCancel}
          sx={{
            color: '#ff8800',
            borderColor: '#ff8800',
            '&:hover': { borderColor: '#ffaa33', bgcolor: 'rgba(255,136,0,0.08)' },
          }}
          data-testid="hyperspace-cancel"
        >
          Abort spool
        </Button>
      </Box>
    );
  }

  if (transitState === 'IN_TRANSIT' || transitState === 'ARRIVED') {
    return (
      <Box
        data-testid="hyperspace-overlay"
        data-transit-state={transitState}
        sx={{
          position: 'fixed',
          inset: 0,
          zIndex: 200,
          pointerEvents: 'none',
          background: transitState === 'ARRIVED'
            ? 'radial-gradient(ellipse at center, rgba(0,255,136,0.22), rgba(5,7,15,0))'
            : 'repeating-linear-gradient(90deg, rgba(0,255,136,0.0) 0, rgba(0,255,136,0.0) 12px, rgba(0,255,136,0.18) 13px, rgba(0,255,136,0.0) 14px)',
          opacity: transitState === 'ARRIVED' ? 0.65 : 0.85,
          transition: 'opacity 400ms, background 400ms',
        }}
      />
    );
  }

  return null;
}
