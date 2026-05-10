import { IconButton, Tooltip } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import { useUIStore } from '../../state/store';
import { Slot } from '../Slot';

/**
 * Top-right icon button that opens the AdvancedDrawer. Lives in its own
 * `drawer-toggle` anchor (separate from `top-right`) so future HUD chips
 * never end up reordering against it.
 */
export function DrawerToggle(): JSX.Element {
  const setDrawerOpen = useUIStore((s) => s.setDrawerOpen);
  return (
    <Slot anchor="top-right" order={1}>
      <Tooltip title="Open panels">
        <IconButton
          aria-label="Open advanced panels"
          data-testid="drawer-toggle"
          onClick={() => setDrawerOpen(true)}
          size="small"
          sx={{
            bgcolor: 'rgba(5,7,15,0.65)',
            backdropFilter: 'blur(4px)',
            border: '1px solid rgba(0, 255, 136, 0.35)',
            color: '#00ff88',
            '&:hover': { bgcolor: 'rgba(0,255,136,0.12)' },
          }}
        >
          <MenuIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Slot>
  );
}
