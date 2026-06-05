import { Box, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { ShipRosterPanel } from './ShipRosterPanel';
import { useUIStore } from '../state/store';
import { useIsCompact } from '../layout/useIsCompact';
import { loadStoredPlayerId } from '../identity/token';
import { useMountLog } from '../debug/useMountLog';

export interface GalaxyOverviewSelectChromeProps {
  onClose: () => void;
}

/**
 * In-game ship-swap overview (single-canvas refactor, Step 6). Opened
 * from the drawer's Galaxy tab ("Show galaxy map") — its real job is the
 * roster ship-swap picker, so post-refactor it is just that: a floating
 * roster panel + close button over a dim scrim of the LIVE game. The
 * former Pixi galaxy backdrop (Map A's second `Application`,
 * `GalaxyOverviewRenderer` in mode='select') is gone — the galaxy there
 * was non-interactive context only. Tap-to-warp still lives on the
 * bottom-center MAP button / M-key overlay (`GalaxyMapLayer`), NOT here.
 *
 * Preserves the load-bearing testids `galaxy-overview-select` and
 * `galaxy-overview-close` and the embedded `ship-roster-panel`.
 */
export function GalaxyOverviewSelectChrome({
  onClose,
}: GalaxyOverviewSelectChromeProps): JSX.Element {
  useMountLog('GalaxyOverviewSelectChrome', {});
  const isCompact = useIsCompact();
  const storedPlayerId = loadStoredPlayerId() ?? '';

  return (
    <Box
      data-testid="galaxy-overview-select"
      sx={{
        position: 'absolute',
        inset: 0,
        // Dim scrim over the live game so the roster stands out; captures
        // pointer events so a tap behind a card doesn't fly the ship.
        bgcolor: 'rgba(5,7,15,0.6)',
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          zIndex: 2,
          ...(isCompact
            ? { left: 8, right: 8, top: 56, height: 60 }
            : { right: 8, top: 56, bottom: 8, width: 156 }),
        }}
      >
        <ShipRosterPanel
          playerId={storedPlayerId}
          compact={isCompact}
          onSpawn={(shipId, sectorKey) => {
            // Direct in-game swap — no spool-up, just a loading screen.
            useUIStore.getState().setPendingShipSwap({ shipId, sectorKey });
            onClose();
          }}
        />
      </Box>

      <IconButton
        onClick={onClose}
        data-testid="galaxy-overview-close"
        sx={{
          position: 'absolute',
          top: 12,
          right: 12,
          color: '#9aa0b4',
          bgcolor: 'rgba(5,7,15,0.7)',
          border: '1px solid #2a2f40',
          '&:hover': { borderColor: '#1f7a4d', color: '#00ff88' },
        }}
        aria-label="Close ship-swap overview"
      >
        <CloseIcon />
      </IconButton>

      <Box
        sx={{
          position: 'absolute',
          top: 12,
          left: 16,
          color: '#9aa0b4',
          fontFamily: 'monospace',
          fontSize: 12,
          letterSpacing: 2,
          textTransform: 'uppercase',
          pointerEvents: 'none',
        }}
      >
        Switch ship · tap a roster card to spawn into it
      </Box>
    </Box>
  );
}
