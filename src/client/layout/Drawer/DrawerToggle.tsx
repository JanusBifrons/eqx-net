import { Box, IconButton, Tooltip } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import { useUIStore } from '../../state/store';
import { RosterCountBadge } from '../../components/RosterCountBadge';

/**
 * Subtle top-right icon button that opens the AdvancedDrawer. The slotting
 * (anchor + ordering) is owned by `TopRightToolbar` so this component is
 * just the presentational chip; render it wherever the toolbar wants it.
 *
 * Phase 5 — adjacent `RosterCountBadge` surfaces N/10 so the player has an
 * always-on cue for roster fullness without opening the drawer. The badge
 * reads from the same Zustand singleton the drawer Galaxy tab uses, so
 * abandon / spawn pushes update both surfaces in lockstep.
 */
export function DrawerToggle(): JSX.Element {
  const setDrawerOpen = useUIStore((s) => s.setDrawerOpen);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <RosterCountBadge />
      <Tooltip title="Open panels">
        <IconButton
          aria-label="Open advanced panels"
          data-testid="drawer-toggle"
          onClick={() => setDrawerOpen(true)}
          sx={{
            p: 0.5,
            opacity: 0.55,
            bgcolor: 'rgba(5,7,15,0.45)',
            backdropFilter: 'blur(4px)',
            border: '1px solid rgba(255,255,255,0.10)',
            color: '#dde',
            transition: 'opacity 120ms, background 120ms',
            '&:hover, &:focus, &:active': {
              opacity: 1,
              bgcolor: 'rgba(5,7,15,0.65)',
            },
          }}
        >
          <MenuIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
