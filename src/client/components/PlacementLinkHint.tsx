/**
 * While placing a structure: a small warning under the ghost when its only
 * links are too short to form ("Can't connect: too close", owner rule "keep
 * buildings apart"); each refused link also draws red in the build preview.
 *
 * Mounted while any kind is being placed; HIDDEN by default. `gameRafLoop`
 * toggles `hidden` + positions it under the projected ghost by direct DOM
 * writes (`updatePlacementHints`), so the per-frame check never re-renders
 * React. Sits a line below the turret fence hint. Desktop and touch.
 */
import { memo } from 'react';
import { Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { TOO_CLOSE_LINK_TEXT } from '../structures/placementHints';

const HINT_SX = {
  position: 'fixed',
  left: '50%',
  top: '66%',
  // Centred under the ghost: `top` is set just past its lower edge.
  transform: 'translateX(-50%)',
  zIndex: 1450,
  pointerEvents: 'none',
  px: 0.75,
  py: 0.25,
  borderRadius: 1,
  bgcolor: 'rgba(40, 12, 12, 0.85)',
  border: '1px solid rgba(255, 110, 90, 0.7)',
} as const;
const TEXT_SX = { fontSize: 10, color: '#ff9a8a', whiteSpace: 'nowrap' } as const;

export const PlacementLinkHint = memo(function PlacementLinkHint() {
  const placementKind = useUIStore((s) => s.placementKind);
  if (!placementKind) return null;
  return (
    <Box data-testid="placement-link-hint" sx={HINT_SX} hidden>
      <Typography sx={TEXT_SX}>{TOO_CLOSE_LINK_TEXT}</Typography>
    </Box>
  );
});
