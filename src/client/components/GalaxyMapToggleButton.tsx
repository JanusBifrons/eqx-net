import { Box } from '@mui/material';
import { useUIStore, useShouldRenderHud } from '../state/store';

/**
 * HUD toggle for the in-game additive galaxy overlay (Map B). Bottom-center
 * slot, mirrors the FIRE/BOOST styling so it reads as part of the action
 * row but in a distinct cyan tone so it doesn't compete visually with combat
 * controls. Tap toggles `isGalaxyMapOpen`; the keyboard `M` shortcut still
 * works in parallel.
 *
 * Hidden while the player is dead (mirrors `WeaponSelector`).
 */
export function GalaxyMapToggleButton(): JSX.Element | null {
  // Plan: crispy-kazoo, Commit 5 — hide HUD during loading curtain.
  const shouldRender = useShouldRenderHud();
  const open = useUIStore((s) => s.isGalaxyMapOpen);
  const isDead = useUIStore((s) => s.isDead);
  const toggle = useUIStore((s) => s.toggleGalaxyMapOpen);

  if (!shouldRender) return null;
  if (isDead) return null;

  return (
    <Box
      component="button"
      data-testid="galaxy-map-toggle"
      aria-pressed={open}
      onPointerUp={(e) => {
        e.preventDefault();
        toggle();
      }}
      sx={{
        ...baseSx,
        ...(open ? openSx : closedSx),
      }}
    >
      MAP
    </Box>
  );
}

const baseSx = {
  width: 52,
  height: 52,
  borderRadius: '50%',
  fontSize: 10,
  fontFamily: 'monospace',
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: 'uppercase',
  cursor: 'pointer',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  touchAction: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s, background-color 0.15s',
} as const;

const closedSx = {
  bgcolor: 'rgba(0, 200, 220, 0.10)',
  border: '1.5px solid rgba(0, 200, 220, 0.55)',
  color: 'rgba(0, 220, 240, 0.95)',
  boxShadow: 'none',
  '&:active': {
    bgcolor: 'rgba(0, 200, 220, 0.18)',
    color: '#00eeff',
  },
};

const openSx = {
  bgcolor: 'rgba(0, 220, 240, 0.18)',
  border: '2px solid #00eeff',
  color: '#00eeff',
  boxShadow: '0 0 14px rgba(0, 220, 240, 0.55)',
};
