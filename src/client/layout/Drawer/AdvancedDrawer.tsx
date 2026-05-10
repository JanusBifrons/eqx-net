import { type ReactNode } from 'react';
import { Box, Drawer, IconButton, Tooltip, Typography } from '@mui/material';
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import HexagonOutlinedIcon from '@mui/icons-material/HexagonOutlined';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import CloseIcon from '@mui/icons-material/Close';
import { useUIStore } from '../../state/store';
import { ProfileTab } from './tabs/ProfileTab';
import { SettingsTab } from './tabs/SettingsTab';
import { GalaxyTab } from './tabs/GalaxyTab';
import { DebugTab } from './tabs/DebugTab';

interface TabSpec {
  id: string;
  label: string;
  icon: ReactNode;
  node: ReactNode;
  /** When true, the tab sticks to the bottom of the rail (after the spacer). */
  bottom?: boolean;
}

/**
 * Vertical icon-only tab rail. Top group renders in document order from the
 * top; bottom group (currently just `debug`) renders pinned to the bottom
 * via a flex spacer between them.
 *
 * Adding a new tab: append to either group. Adding a new bottom-pinned
 * tab: set `bottom: true`. The catalogue is the single source of truth.
 */
const TABS: readonly TabSpec[] = [
  { id: 'galaxy',   label: 'Galaxy',      icon: <HexagonOutlinedIcon />,       node: <GalaxyTab /> },
  { id: 'profile',  label: 'Profile',     icon: <AccountCircleOutlinedIcon />, node: <ProfileTab /> },
  { id: 'settings', label: 'Settings',    icon: <SettingsOutlinedIcon />,      node: <SettingsTab /> },
  { id: 'debug',    label: 'Debug',       icon: <BugReportOutlinedIcon />,     node: <DebugTab />, bottom: true },
];

const RAIL_WIDTH = 56;

/**
 * Right-edge advanced drawer.
 *
 * **Performance contract**: this is a plain `Drawer`, NOT `SwipeableDrawer`.
 * SwipeableDrawer attaches global touchstart/touchmove listeners that fire
 * on every joystick movement and tank prediction RTT (~50 ms → ~2 s on
 * Android). Likewise `keepMounted` is intentionally OFF so tab content
 * (`ConnectionDiagnostics`, `DevOverlay`, etc.) only mounts when the drawer
 * is open — otherwise they re-render at the snapshot rate (~17 Hz) and
 * starve the Pixi RAF loop on mobile.
 *
 * Pixi keeps running underneath — the drawer paints on a higher z-index
 * tier (`Z.drawer = 1200`) but doesn't resize or remount the canvas.
 */
export function AdvancedDrawer(): JSX.Element {
  const isDrawerOpen = useUIStore((s) => s.isDrawerOpen);
  const drawerTab = useUIStore((s) => s.drawerTab);
  const setDrawerOpen = useUIStore((s) => s.setDrawerOpen);
  const setDrawerTab = useUIStore((s) => s.setDrawerTab);

  const activeId = TABS.some((t) => t.id === drawerTab) ? drawerTab : TABS[0]!.id;
  const active = TABS.find((t) => t.id === activeId)!;

  const topTabs = TABS.filter((t) => !t.bottom);
  const bottomTabs = TABS.filter((t) => t.bottom);

  return (
    <Drawer
      anchor="right"
      open={isDrawerOpen}
      onClose={() => setDrawerOpen(false)}
      data-testid="advanced-drawer"
      sx={{
        '& .MuiDrawer-paper': {
          width: 'min(360px, 90vw)',
          bgcolor: '#0d1117',
          borderLeft: '1px solid rgba(0, 255, 136, 0.18)',
          color: '#dde',
          // Clear the fixed AppHeader so its avatar/buttons don't intercept
          // clicks on the drawer's own header on desktop.
          pt: 'var(--app-bar-h, 48px)',
          display: 'flex',
          flexDirection: 'column',
        },
      }}
    >
      {/* Drawer header — close button + active tab label */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1.5,
          py: 1,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          minHeight: 44,
        }}
      >
        <Typography variant="overline" sx={{ color: '#00ff88', letterSpacing: 2, pl: 1 }}>
          {active.label}
        </Typography>
        <IconButton
          aria-label="Close drawer"
          data-testid="drawer-close"
          onClick={() => setDrawerOpen(false)}
          size="small"
          sx={{ color: '#9aa0b4' }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Body: vertical tab rail (left) + active panel (right) */}
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Box
          role="tablist"
          aria-orientation="vertical"
          sx={{
            width: RAIL_WIDTH,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            borderRight: '1px solid rgba(255,255,255,0.08)',
            py: 1,
            gap: 0.5,
          }}
        >
          {topTabs.map((t) => (
            <RailButton
              key={t.id}
              tab={t}
              active={t.id === activeId}
              onClick={() => setDrawerTab(t.id)}
            />
          ))}

          {/* Spacer pushes bottomTabs to the bottom of the rail */}
          <Box sx={{ flex: 1, minHeight: 8 }} />

          {bottomTabs.map((t) => (
            <RailButton
              key={t.id}
              tab={t}
              active={t.id === activeId}
              onClick={() => setDrawerTab(t.id)}
            />
          ))}
        </Box>

        {/* Active panel — only the active tab is mounted (perf) */}
        <Box
          role="tabpanel"
          data-testid={`drawer-panel-${activeId}`}
          sx={{ flex: 1, minWidth: 0, overflow: 'auto' }}
        >
          {active.node}
        </Box>
      </Box>
    </Drawer>
  );
}

interface RailButtonProps {
  tab: TabSpec;
  active: boolean;
  onClick: () => void;
}

function RailButton({ tab, active, onClick }: RailButtonProps): JSX.Element {
  return (
    <Tooltip title={tab.label} placement="left">
      <IconButton
        role="tab"
        aria-selected={active}
        aria-label={tab.label}
        data-testid={`drawer-tab-${tab.id}`}
        onClick={onClick}
        sx={{
          width: RAIL_WIDTH - 12,
          height: RAIL_WIDTH - 12,
          borderRadius: 1,
          color: active ? '#00ff88' : '#9aa0b4',
          bgcolor: active ? 'rgba(0, 255, 136, 0.10)' : 'transparent',
          borderLeft: active ? '2px solid #00ff88' : '2px solid transparent',
          '&:hover': {
            bgcolor: active ? 'rgba(0, 255, 136, 0.16)' : 'rgba(255, 255, 255, 0.06)',
            color: active ? '#00ff88' : '#dde',
          },
        }}
      >
        {tab.icon}
      </IconButton>
    </Tooltip>
  );
}
