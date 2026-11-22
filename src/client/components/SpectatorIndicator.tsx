import { Box } from '@mui/material';
import ExploreIcon from '@mui/icons-material/Explore';
import ConstructionIcon from '@mui/icons-material/Construction';
import { selectControlMode, useShowLoadingScreen, useUIStore } from '../state/store';
import { Slot } from '../layout/Slot';

/**
 * An on-screen sign of the mode the player is in when not flying (RTS slice
 * 10; was "Spectating"): COMMAND VIEW (free camera over the fleet, every ship
 * AI-flown) or BUILD MODE (the third mode: placing structures). The free camera
 * otherwise looks like flying, so without this there's no sign you've let go.
 * Discrete store read (Invariant #2). Tiny + unobtrusive.
 */

const SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
  px: { xs: 0.75, sm: 1 },
  py: { xs: 0.25, sm: 0.4 },
  // The same dark HUD backing as the lock band's target chip. It was a 14%
  // green wash, so ships, fireballs and damage numbers showed through the
  // chip and its text ran into a world number beside it ("SPECTATING64",
  // showcase review 2026-11-13). Lock: tests/e2e/spectator-mode.spec.ts.
  bgcolor: 'rgba(6,10,20,0.75)',
  border: '1px solid rgba(0,255,136,0.55)',
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
  // Never over the join loading screen (sector briefing card).
  const loadingScreen = useShowLoadingScreen();
  if (phase !== 'game' || controlMode === 'fly' || loadingScreen) return null;
  if (controlMode === 'build') {
    return (
      <Box sx={SX} data-testid="build-mode-indicator">
        <ConstructionIcon />
        Build mode
      </Box>
    );
  }
  return (
    <Box sx={SX} data-testid="spectator-indicator">
      <ExploreIcon />
      Command view
    </Box>
  );
}

/**
 * Where the badge sits: top-left, by the mode switch, in EVERY mode and on
 * every screen (owner 2026-11-22: Command had it top-centre, right in your
 * view, while Build had it top-left; one place for all). The chip is
 * display-only, so its slot is click-through: a pointer-events:auto wrapper
 * over the map swallowed Command-view clicks and right-click move orders
 * (PR #1098 fleet-command e2e).
 */
export function ControlModeBadge(): JSX.Element {
  return <Slot anchor="top-left" order={3} pointerEvents="none"><SpectatorIndicator /></Slot>;
}
