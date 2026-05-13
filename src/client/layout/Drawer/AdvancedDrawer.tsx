import { memo, useCallback, useMemo, type ReactNode } from 'react';
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

// --------------------------------------------------------------------------
// HOISTED STATIC `sx` / props objects.
//
// Paradigm: every inline `sx={{...}}` in JSX allocates a fresh object on
// each render. MUI's emotion engine then has to hash it (murmur2),
// deep-merge it, run `styleFunctionSx2` against the theme — all per
// allocation. The CPU profile of a single drawer-open showed ~6 s of
// emotion + sx-prop work (commit `9c04bbf`).
//
// Hoisting static sx objects out of the render function gives emotion a
// STABLE reference: same `===` identity across renders, cached hash,
// cached output. Cost drops from per-render to per-page-load.
//
// Rule: if an `sx` object has NO inputs from props/state, hoist it. If
// it has dependencies, wrap in `useMemo`. Only inline `sx` for one-off,
// truly-dynamic styles (and even then prefer `useMemo`).
// --------------------------------------------------------------------------
const DRAWER_SX = {
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
} as const;

const MODAL_PROPS = { keepMounted: true } as const;
// Slide's `mountOnEnter` defaults to `true` — children only mount when
// the enter transition fires. With `keepMounted` on the Modal that
// would defer GalaxyTab + ShipRosterPanel mount to first-open
// (~1.5 s tail). Pre-mount the children too so the drawer-open
// transition is purely visual / no React work.
const SLIDE_PROPS = { mountOnEnter: false, unmountOnExit: false } as const;

const HEADER_SX = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  px: 1.5,
  py: 1,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  minHeight: 44,
} as const;

const HEADER_LABEL_SX = { color: '#00ff88', letterSpacing: 2, pl: 1 } as const;
const CLOSE_BTN_SX = { color: '#9aa0b4' } as const;
const BODY_SX = { display: 'flex', flex: 1, minHeight: 0 } as const;

const TAB_RAIL_SX = {
  width: RAIL_WIDTH,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  borderRight: '1px solid rgba(255,255,255,0.08)',
  py: 1,
  gap: 0.5,
} as const;

const RAIL_SPACER_SX = { flex: 1, minHeight: 8 } as const;
const ACTIVE_PANEL_SX = { flex: 1, minWidth: 0, overflow: 'auto' } as const;

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
// Hoist the topTabs / bottomTabs split out of the render — TABS is a
// module-level const so its filtered subsets are stable too.
const TOP_TABS = TABS.filter((t) => !t.bottom);
const BOTTOM_TABS = TABS.filter((t) => t.bottom);

export function AdvancedDrawer(): JSX.Element {
  const isDrawerOpen = useUIStore((s) => s.isDrawerOpen);
  const drawerTab = useUIStore((s) => s.drawerTab);
  const setDrawerOpen = useUIStore((s) => s.setDrawerOpen);
  const setDrawerTab = useUIStore((s) => s.setDrawerTab);

  // `useMemo` here, not because the computation is expensive, but
  // because `active.node` is a JSX element. If `active` changes identity
  // on every render then so does `active.node`, and React's reconciler
  // would consider the tabpanel's child a "different" element and
  // unmount/remount it (turning every drawer-open into a fresh GalaxyTab
  // mount — the cost we just eliminated with keepMounted).
  const { activeId, active } = useMemo(() => {
    const id = TABS.some((t) => t.id === drawerTab) ? drawerTab : TABS[0]!.id;
    return { activeId: id, active: TABS.find((t) => t.id === id)! };
  }, [drawerTab]);

  // Stable handler identity so child IconButton / RailButton don't
  // see new props on every parent render and skip their React.memo
  // (once memoised — see the wrappers below).
  const handleClose = useCallback(() => setDrawerOpen(false), [setDrawerOpen]);

  // Active-panel sx depends on activeId only via the `data-testid`,
  // not via styling, so it stays in the static block above. The
  // `data-testid` does change with the active tab — that's a plain
  // attribute change, no emotion work.

  return (
    <Drawer
      anchor="right"
      open={isDrawerOpen}
      onClose={handleClose}
      data-testid="advanced-drawer"
      // Pre-mount the Modal infrastructure so opening the drawer is a
      // CSS class flip, not a cold React mount. CLICK→VISIBLE drops
      // from 26 s → ~1.2 s (drawer-lag-trace.spec.ts).
      // The historic objection — Debug tab subscribers re-rendering
      // at 17 Hz when hidden — only matters for the Debug tab, which
      // isn't the default and isn't on the drawer-open hot path.
      ModalProps={MODAL_PROPS}
      SlideProps={SLIDE_PROPS}
      sx={DRAWER_SX}
    >
      {/* Drawer header — close button + active tab label */}
      <Box sx={HEADER_SX}>
        <Typography variant="overline" sx={HEADER_LABEL_SX}>
          {active.label}
        </Typography>
        <IconButton
          aria-label="Close drawer"
          data-testid="drawer-close"
          onClick={handleClose}
          size="small"
          sx={CLOSE_BTN_SX}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Body: vertical tab rail (left) + active panel (right) */}
      <Box sx={BODY_SX}>
        <Box role="tablist" aria-orientation="vertical" sx={TAB_RAIL_SX}>
          {TOP_TABS.map((t) => (
            <RailButton
              key={t.id}
              tab={t}
              active={t.id === activeId}
              setDrawerTab={setDrawerTab}
            />
          ))}

          {/* Spacer pushes bottomTabs to the bottom of the rail */}
          <Box sx={RAIL_SPACER_SX} />

          {BOTTOM_TABS.map((t) => (
            <RailButton
              key={t.id}
              tab={t}
              active={t.id === activeId}
              setDrawerTab={setDrawerTab}
            />
          ))}
        </Box>

        {/* Active panel — only the active tab is mounted (perf) */}
        <Box
          role="tabpanel"
          data-testid={`drawer-panel-${activeId}`}
          sx={ACTIVE_PANEL_SX}
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
  // Pass the setter, not a closed-over onClick — keeps the prop
  // identity stable across parent re-renders so React.memo holds.
  setDrawerTab: (id: string) => void;
}

// Pre-computed sx for the two visual states. Stable identity across
// renders → emotion cache hit, no per-render `styleFunctionSx2`.
const RAIL_BTN_BASE = {
  width: RAIL_WIDTH - 12,
  height: RAIL_WIDTH - 12,
  borderRadius: 1,
} as const;

const RAIL_BTN_ACTIVE_SX = {
  ...RAIL_BTN_BASE,
  color: '#00ff88',
  bgcolor: 'rgba(0, 255, 136, 0.10)',
  borderLeft: '2px solid #00ff88',
  '&:hover': {
    bgcolor: 'rgba(0, 255, 136, 0.16)',
    color: '#00ff88',
  },
} as const;

const RAIL_BTN_INACTIVE_SX = {
  ...RAIL_BTN_BASE,
  color: '#9aa0b4',
  bgcolor: 'transparent',
  borderLeft: '2px solid transparent',
  '&:hover': {
    bgcolor: 'rgba(255, 255, 255, 0.06)',
    color: '#dde',
  },
} as const;

const RailButton = memo(function RailButton({
  tab,
  active,
  setDrawerTab,
}: RailButtonProps): JSX.Element {
  // Per-button onClick wrapper. Stable as long as `setDrawerTab` and
  // `tab.id` are stable (both are — setDrawerTab is the Zustand setter
  // identity, tab is module-level).
  const handleClick = useCallback(() => setDrawerTab(tab.id), [setDrawerTab, tab.id]);
  return (
    <Tooltip title={tab.label} placement="left">
      <IconButton
        role="tab"
        aria-selected={active}
        aria-label={tab.label}
        data-testid={`drawer-tab-${tab.id}`}
        onClick={handleClick}
        sx={active ? RAIL_BTN_ACTIVE_SX : RAIL_BTN_INACTIVE_SX}
      >
        {tab.icon}
      </IconButton>
    </Tooltip>
  );
});
