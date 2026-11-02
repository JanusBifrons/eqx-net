/**
 * While placing a turret: a small warning under the ghost when a shield wall
 * lies within the turret's range ("a fence blocks every shot, its owner's
 * turret fire included", user ruling 2026-11-02).
 *
 * Mounted only while a shot-firing kind is being placed; HIDDEN by default.
 * `gameRafLoop` decides each frame (`turretFireCrossesWall`, alloc-free) and
 * toggles `hidden` + positions it under the projected ghost by direct DOM
 * writes, so the per-frame check never re-renders React. Desktop and touch.
 */
import { memo } from 'react';
import { Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { turretRangeOf } from '../structures/fenceFireHint';

const HINT_SX = {
  position: 'fixed',
  left: '50%',
  top: '66%',
  // Just BELOW the anchor point (the ghost), horizontally centred on it.
  transform: 'translate(-50%, 18px)',
  zIndex: 1450,
  pointerEvents: 'none',
  px: 0.75,
  py: 0.25,
  borderRadius: 1,
  bgcolor: 'rgba(40, 18, 12, 0.85)',
  border: '1px solid rgba(255, 150, 90, 0.7)',
} as const;
const TEXT_SX = { fontSize: 10, color: '#ffb48a', whiteSpace: 'nowrap' } as const;

export const PlacementFenceHint = memo(function PlacementFenceHint() {
  const placementKind = useUIStore((s) => s.placementKind);
  if (!placementKind || turretRangeOf(placementKind) <= 0) return null;
  return (
    <Box data-testid="placement-fence-hint" sx={HINT_SX} hidden>
      <Typography sx={TEXT_SX}>A shield wall in range will stop this turret&apos;s fire</Typography>
    </Box>
  );
});
