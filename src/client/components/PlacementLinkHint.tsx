/**
 * While placing a structure: a small warning under the ghost when it cannot
 * go there at all (the server's refusal notice, e.g. "Can't build here:
 * blocked by an asteroid or wreck"), or when its only
 * links are too short to form ("Can't connect: too close", owner rule "keep
 * buildings apart"); each refused link also draws red in the build preview.
 *
 * Mounted while any kind is being placed; HIDDEN by default. `gameRafLoop`
 * toggles `hidden` + positions it under the projected ghost by direct DOM
 * writes (`updatePlacementHints`), so the per-frame check never re-renders
 * React. Sits a line below the turret fence hint. On touch it is docked under
 * the top-centre placement banner instead (not moved).
 */
import { memo } from 'react';
import { Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { isTouchDevice } from '../input/TouchInput';
import { TOO_CLOSE_LINK_TEXT } from '../structures/placementHints';

const LOOK_SX = {
  bgcolor: 'rgba(40, 12, 12, 0.85)',
  border: '1px solid rgba(255, 110, 90, 0.7)',
} as const;
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
  ...LOOK_SX,
} as const;
const TEXT_SX = { fontSize: 10, color: '#ff9a8a', whiteSpace: 'nowrap' } as const;

/** Docked inside the touch placement banner's top-centre block (no per-frame
 *  positioning: `data-docked`); undocked it follows the ghost (desktop). */
const DOCKED_SX = { pointerEvents: 'none', px: 0.75, py: 0.25, borderRadius: 1, ...LOOK_SX } as const;

export const PlacementLinkHint = memo(function PlacementLinkHint({ docked = false }: { docked?: boolean }) {
  const placementKind = useUIStore((s) => s.placementKind);
  if (!placementKind) return null;
  // Touch shows the docked copy (inside the banner); never both.
  if (!docked && isTouchDevice()) return null;
  return (
    <Box data-docked={docked ? '1' : undefined} data-testid="placement-link-hint" sx={docked ? DOCKED_SX : HINT_SX} hidden>
      <Typography sx={TEXT_SX}>{TOO_CLOSE_LINK_TEXT}</Typography>
    </Box>
  );
});
