/**
 * Phase 5 — roster-count badge for the drawer toggle area.
 *
 * Reads `shipRoster` from the singleton Zustand cache (populated once on
 * player-id-known and refreshed by `SHIP_ROSTER` server push). Renders a
 * tiny chip with the owned-ship count `N` (no cap — rosters are unlimited) and a `data-state` attribute the test suite can
 * assert on without coupling to CSS specifics.
 *
 * Visual states (driven by `data-state`):
 *  - `empty`  (N === 0):   muted grey, low-emphasis
 *  - `normal` (N > 0):     default green
 */
import { Box } from '@mui/material';
import { useUIStore, useShouldRenderHud } from '../state/store.js';

export function RosterCountBadge(): JSX.Element | null {
  // Plan: crispy-kazoo, Commit 5 — hide HUD during loading curtain.
  const shouldRender = useShouldRenderHud();
  const count = useUIStore((s) => s.shipRoster.length);
  if (!shouldRender) return null;
  const state: 'empty' | 'normal' = count === 0 ? 'empty' : 'normal';
  const color =
    state === 'empty' ? '#666' :
    '#00ff88';
  return (
    <Box
      component="span"
      data-testid="roster-count-badge"
      data-state={state}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 28,
        height: 14,
        px: 0.5,
        borderRadius: 0.5,
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: 0.3,
        color,
        border: '1px solid',
        borderColor: color,
        bgcolor: 'transparent',
        lineHeight: 1,
      }}
    >
      {count}
    </Box>
  );
}
