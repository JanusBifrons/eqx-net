import { Box } from '@mui/material';
import { useUIStore } from '../state/store';
import { Slot } from './Slot';
import { DrawerToggle } from './Drawer/DrawerToggle';
import { FullscreenToggle } from './FullscreenToggle';

/**
 * Single top-right anchor mount for the in-game toggle row. Renders the
 * advanced-drawer toggle (game phase only — the drawer is mounted alongside
 * `GameSurface`) and the fullscreen toggle (touch + non-standalone) inline
 * with row-flex so the chips sit side-by-side instead of stacking.
 *
 * Each child controls its own visibility — `FullscreenToggle` returns null on
 * desktop / PWA, and the drawer toggle here only renders when `phase ===
 * 'game'`. The row-flex Box collapses gracefully if both are absent.
 */
export function TopRightToolbar(): JSX.Element {
  const phase = useUIStore((s) => s.phase);
  const showDrawerToggle = phase === 'game';
  return (
    <Slot anchor="top-right" order={1}>
      <Box
        data-testid="top-right-toolbar"
        sx={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 0.5,
        }}
      >
        {showDrawerToggle && <DrawerToggle />}
        <FullscreenToggle />
      </Box>
    </Slot>
  );
}
