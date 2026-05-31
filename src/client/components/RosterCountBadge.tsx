/**
 * Phase 5 — roster-count badge for the drawer toggle area.
 *
 * Reads `shipRoster` from the singleton Zustand cache (populated once on
 * player-id-known and refreshed by `SHIP_ROSTER` server push). Renders a
 * tiny chip with `N/10` and a `data-state` attribute the test suite can
 * assert on without coupling to CSS specifics.
 *
 * Visual states (driven by `data-state`):
 *  - `empty`  (N === 0):   muted grey, low-emphasis
 *  - `normal` (0 < N < 10): default green
 *  - `full`   (N === 10):  red, draws attention to abandon-to-make-room
 */
import { Box } from '@mui/material';
import { useUIStore, useShouldRenderHud } from '../state/store.js';
import { ROSTER_CAP } from './rosterConstants';

export function RosterCountBadge(): JSX.Element | null {
  // Plan: crispy-kazoo, Commit 5 — hide HUD during loading curtain.
  const shouldRender = useShouldRenderHud();
  const count = useUIStore((s) => s.shipRoster.length);
  if (!shouldRender) return null;
  const state: 'empty' | 'normal' | 'full' =
    count === 0 ? 'empty' : count >= ROSTER_CAP ? 'full' : 'normal';
  const color =
    state === 'full' ? '#ff5566' :
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
        bgcolor: state === 'full' ? 'rgba(255,85,102,0.08)' : 'transparent',
        lineHeight: 1,
      }}
    >
      {count}/{ROSTER_CAP}
    </Box>
  );
}
