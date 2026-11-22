import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import SpeedDial from '@mui/material/SpeedDial';
import SpeedDialAction from '@mui/material/SpeedDialAction';
import SpeedDialIcon from '@mui/material/SpeedDialIcon';
import type { FabProps } from '@mui/material/Fab';
import MenuIcon from '@mui/icons-material/Menu';
import MapIcon from '@mui/icons-material/Map';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import FastForwardIcon from '@mui/icons-material/FastForward';
import { SOLAR_SECTORS } from '../../shared-types/sectorBounds';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { openDrawerPanel } from '../state/rightPanel';
import { getShipKind } from '@shared-types/shipKinds';
import { type StructureKindId } from '@shared-types/structureKinds';
import { useTouchClickActivate } from './touchClickActivate';
import { onGameWindowOpen } from './GameWindow';
import { FIT_OPEN_LIST_SX, useFitActionsToViewport } from './speedDialFit';
import { BuildSidebar, onBuildSidebarRequest } from './BuildSidebar';
import { cancelPlacement } from '../structures/placementCancel';

/** The Build sidebar's view: closed, the full list, or folded to the placing
 *  strip (only shown while a kind is picked). */
type BuildView = 'closed' | 'full' | 'strip';

/**
 * Consolidated bottom-right action menu (speed-dial UI refactor).
 *
 * A single MUI `SpeedDial` FAB that hosts the game's *discrete* (tap, not
 * held) HUD actions — what used to be scattered across the bottom-center MAP
 * button (`GalaxyMapToggleButton`), the bottom thumb-cluster weapon toggle
 * (`SlotSelector`), and the drawer toggle. The continuous/held controls
 * (move stick, lock line + BOOST in `GameHud`) deliberately stay as their own
 * dedicated buttons — a tap-to-expand FAB is the wrong affordance for an input
 * you hold down (confirmed with the user).
 *
 * Placement: it portals into the `bottom-right` anchor at `order={1}` — the
 * LOWEST order, which is the corner-most slot in the row-reverse bottom-right
 * anchor. So the dial sits in the bottom-right CORNER, to the right of the AUTO
 * toggle (order 5) and the FIRE/BOOST cluster (orders 10/20), on both touch and
 * desktop. The dial expands UPWARD (`direction="up"`).
 *
 * Multitouch (smoke handoff 2026-06-06): MUI `SpeedDial` opens via a synthesized
 * CLICK, which mobile browsers only emit for the PRIMARY touch — so a second
 * simultaneous touch (tapping the dial while the joystick is held) never opened
 * it. The FAB + each action therefore also bind `onTouchStart` (delivered to a
 * second touch point, like FIRE/BOOST), with a short post-touch click-suppression
 * window so the trailing synthesized click doesn't double-fire. `onClick` stays
 * live for desktop. **Every test-observable / handler prop is passed through
 * `FabProps`, not as a direct prop** — with `tooltipOpen` set (always-visible
 * labels, WS-13) each action takes MUI's static-tooltip branch where direct
 * props spread onto the label wrapper span, not the Fab; routing through
 * `FabProps` (`slotProps.fab`) keeps `data-testid` / `aria-pressed` / handlers on
 * the Fab button, identical to the pre-tooltipOpen placement.
 *
 * Build menu: the dial does NOT build (owner, 2026-11-22: one way to build).
 * Build mode is the only way in: entering it opens the Build sidebar
 * (BuildSidebar.tsx: a category rail and kind tiles), and a Build tap while
 * already in Build reopens it after a ✕ (onBuildSidebarRequest). The dial keeps
 * the basics only (Panels, Map, Weapon, Warp) until its own redesign. Picking a kind sets
 * `placementKind` (entering Build mode) and folds the sidebar to the placing
 * strip (BuildPlacingStrip.tsx), so it never covers the ghost; Confirm keeps
 * placing the same building (placementCancel.ts) with it folded; the strip's
 * portrait expands it (placement stays live) and the full sidebar's ✕ folds it
 * back; Cancel (the strip's ✕ too: the ghost goes, Build stays) brings the full
 * list back; entering Build opens it, leaving Build closes it.
 * Categories live client-side only (no wire field, no version bump, no netgate).
 *
 * Perf: all static `sx` is hoisted to module-level consts (no per-render alloc,
 * per the drawer-perf rules). The dial's and the sidebar's open flags are local
 * React state — pure presentation, never Zustand (invariant #2).
 */
export interface SpeedDialMenuProps {
  /** Opening direction. Legacy HUD: 'up' from the bottom-right corner. The
   *  experimental HUDs (exp/hud-mobile-first) park it top-right opening 'down'
   *  so it never competes with the thumb zones. */
  direction?: 'up' | 'down';
}

export function SpeedDialMenu({ direction = 'up' }: SpeedDialMenuProps = {}): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const isDead = useUIStore((s) => s.isDead);
  const isGalaxyMapOpen = useUIStore((s) => s.isGalaxyMapOpen);
  const toggleGalaxyMapOpen = useUIStore((s) => s.toggleGalaxyMapOpen);
  const activeSlotId = useUIStore((s) => s.activeSlotId);
  const shipKindId = useUIStore((s) => s.selectedShipKind);
  const setActiveSlotId = useUIStore((s) => s.setActiveSlotId);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);
  // Phase 4: warp-to in a solar-system sector (the picker; wrap-up W1a).
  const sectorKey = useUIStore((s) => s.currentSectorKey);
  const setWarpPickerOpen = useUIStore((s) => s.setWarpPickerOpen);
  const canWarp = SOLAR_SECTORS && sectorKey !== null;

  const [open, setOpen] = useState(false);
  // The Build sidebar (BuildSidebar.tsx) — pure presentation, local state.
  const [buildView, setBuildView] = useState<BuildView>('closed');

  // Multitouch support (smoke handoff 2026-06-06). We drive the FAB + actions on
  // `onTouchStart` so a SECOND simultaneous touch opens/activates them; the
  // trailing synthesized click is dropped within the suppress window. `onClick`
  // stays live for desktop (one impl: `useTouchClickActivate`).
  const { touchActivate, clickActivate, isWithinSuppressWindow } = useTouchClickActivate();

  // A game window or the building settings panel opening closes the dial and
  // the Build sidebar (one right panel at a time): the window takes focus, so no blur.
  const collapse = useCallback(() => {
    setOpen(false);
    setBuildView('closed');
  }, []);
  useEffect(() => onGameWindowOpen(collapse), [collapse]);

  const close = useCallback(() => {
    setOpen(false);
    // Drop DOM focus from whatever speed-dial button the player just activated
    // (Map / Panels / Weapon). MUI Fab buttons activate on Space/Enter while
    // focused, so a still-focused Map FAB meant the next Space/Fire silently
    // re-toggled the galaxy overlay (WS-F #18). Blurring on close makes every
    // terminal selection lose focus.
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  // Build mode keeps the build menu ready: entering Build (the mode switch) and
  // every placement end (Cancel, or a place-once kind placed: the ghost goes,
  // Build stays) open the Build sidebar for the next structure, so the strip
  // goes. A Confirm keeps placing, so it stays folded. Leaving Build closes it
  // and the dial.
  const building = useUIStore((s) => s.buildMode);
  const buildListReady = useUIStore((s) => s.buildMode && s.placementKind === null);
  const wasBuilding = useRef(false);
  useEffect(() => {
    if (buildListReady) {
      setOpen(false);
      setBuildView('full');
    } else if (!building && wasBuilding.current) {
      collapse();
    }
    wasBuilding.current = building;
  }, [building, buildListReady, collapse]);

  const toggleOpen = useCallback(() => setOpen((o) => !o), []);

  const handleMenu = useCallback(() => {
    close();
    openDrawerPanel(useUIStore.getState());
  }, [close]);

  const handleWarp = useCallback(() => {
    close();
    setWarpPickerOpen(true);
  }, [close, setWarpPickerOpen]);

  const handleMap = useCallback(() => {
    close();
    toggleGalaxyMapOpen();
  }, [close, toggleGalaxyMapOpen]);

  const handleWeapon = useCallback(() => {
    close();
    // Cycle to the next weapon slot on the local ship. Today every gameplay
    // ship has exactly one slot, so this is a no-op affordance that still
    // surfaces "this is your hot slot"; it becomes a real cycle the moment a
    // multi-slot kind ships.
    const slots = getShipKind(shipKindId).slots ?? [];
    if (slots.length === 0) return;
    const idx = slots.findIndex((s) => s.id === activeSlotId);
    const next = slots[(idx + 1) % slots.length];
    if (next) setActiveSlotId(next.id);
  }, [close, shipKindId, activeSlotId, setActiveSlotId]);

  // A Build tap while already in Build (the mode switch) brings the sidebar back.
  useEffect(() => onBuildSidebarRequest(() => {
    if (!useUIStore.getState().buildMode) return;
    setOpen(false);
    setBuildView('full');
  }), []);
  // The full sidebar's ✕ / swipe: while placing it folds to the strip.
  const closeBuild = useCallback(() => {
    setBuildView(useUIStore.getState().placementKind !== null ? 'strip' : 'closed');
  }, []);
  const expandBuild = useCallback(() => setBuildView('full'), []);
  // The open list fits the screen (sideways phone) and scrolls: speedDialFit.ts.
  const dialRef = useRef<HTMLDivElement>(null);
  useFitActionsToViewport(dialRef, direction, open);

  // Pick a kind to place: raise the placement ghost and fold the sidebar to the
  // strip, so it never covers the ghost (build mode, stills review 2026-11-20).
  // Cancel brings it back on the same category (the R2.6 repeat-build need).
  const handlePickBuild = useCallback(
    (kind: StructureKindId) => {
      setPlacementKind(kind);
      setBuildView('strip');
      (document.activeElement as HTMLElement | null)?.blur();
    },
    [setPlacementKind],
  );

  if (!shouldRender || isDead) return null;

  const slots = getShipKind(shipKindId).slots ?? [];
  const activeSlot = slots.find((s) => s.id === activeSlotId) ?? slots[0];
  const weaponLabel = activeSlot ? `Weapon: ${activeSlot.displayName}` : 'Weapon';

  const actions: ReactNode = [
      <SpeedDialAction
        key="menu"
        icon={<MenuIcon />}
        tooltipTitle="Panels"
        tooltipOpen
        FabProps={fab(MENU_ACTION_FAB_PROPS, {
          'data-testid': 'speed-dial-menu',
          onClick: clickActivate(handleMenu),
          onTouchStart: touchActivate(handleMenu),
        })}
      />,
      <SpeedDialAction
        key="map"
        icon={<MapIcon />}
        tooltipTitle="Map"
        tooltipOpen
        FabProps={fab(mapActionFabProps(isGalaxyMapOpen), {
          'data-testid': 'galaxy-map-toggle',
          'aria-pressed': isGalaxyMapOpen,
          onClick: clickActivate(handleMap),
          onTouchStart: touchActivate(handleMap),
        })}
      />,
      <SpeedDialAction
        key="weapon"
        icon={<GpsFixedIcon />}
        tooltipTitle={weaponLabel}
        tooltipOpen
        FabProps={fab(WEAPON_ACTION_FAB_PROPS, {
          'data-testid': 'slot-selector',
          'data-slot-id': activeSlot?.id,
          onClick: clickActivate(handleWeapon),
          onTouchStart: touchActivate(handleWeapon),
        })}
      />,
      ...(canWarp ? [
        <SpeedDialAction
          key="warp"
          icon={<FastForwardIcon />}
          tooltipTitle="Warp ▸"
          tooltipOpen
          FabProps={fab(ACTION_FAB_BASE, {
            'data-testid': 'speed-dial-warp',
            onClick: clickActivate(handleWarp),
            onTouchStart: touchActivate(handleWarp),
          })}
        />,
      ] : []),
  ];
  // Phase 5 — the pilot↔spectator toggle MOVED OUT of the speed-dial into the
  // always-visible `PilotSpectatorToggle` (the user: it "was NOT designed to be
  // part of the speeddial… visible at all times"). The speed-dial no longer
  // carries a spectator action.

  return (
    <>
    <BuildSidebar open={buildView === 'full'} strip={buildView === 'strip'} onClose={closeBuild}
      onPick={handlePickBuild} onExpand={expandBuild} onCancel={cancelPlacement} />
    <SpeedDial
      ref={dialRef}
      ariaLabel="Game actions"
      data-testid="speed-dial"
      icon={<SpeedDialIcon />}
      direction={direction}
      open={open}
      // Ignore the MUI 'toggle' reason (its synthesized-click open/close) within
      // the suppression window — our `onTouchStart` already toggled `open`, so
      // letting the trailing click toggle again would immediately undo it.
      // Only a deliberate toggle opens the dial: MUI also opens on 'mouseEnter'
      // and 'focus' (after a 0 ms timer), and then the click that follows the
      // hover saw the dial open and toggled it SHUT. Ignoring them matches
      // onClose, which ignores 'blur' / 'mouseLeave'.
      onOpen={(_e, reason) => {
        if (reason !== 'toggle') return;
        if (isWithinSuppressWindow()) return;
        setOpen(true);
      }}
      // MUI fires onClose on 'blur' / 'mouseLeave' too — e.g. when the player
      // clicks the canvas — and we IGNORE those so an incidental focus change
      // doesn't dismiss the dial. Only a deliberate FAB toggle or Escape closes
      // it; the terminal actions (Panels/Map/Weapon/Warp) close via close().
      onClose={(_e, reason) => {
        if (reason === 'toggle') {
          if (isWithinSuppressWindow()) return;
          close();
        } else if (reason === 'escapeKeyDown') {
          close();
        }
        // 'blur' / 'mouseLeave' → ignored: a stray focus change never closes it.
      }}
      FabProps={{ ...FAB_PROPS, onTouchStart: touchActivate(toggleOpen) }}
      sx={direction === 'down' ? DIAL_SX_DOWN : DIAL_SX}
    >
      {actions}
    </SpeedDial>
    </>
  );
}

/**
 * Build the per-action Fab props. MUI's `Partial<FabProps>` carries no data- or
 * aria- index signature, but the Fab forwards arbitrary DOM attrs at runtime —
 * so we merge through one cast. Routing `data-testid` / `aria-pressed` / handlers
 * via `FabProps` (not as direct `SpeedDialAction` props) is LOAD-BEARING under
 * `tooltipOpen`: in MUI's static-tooltip branch a direct prop spreads onto the
 * label wrapper span, not the Fab button — which would move every E2E selector
 * off the button. Spreading into `FabProps` keeps them on the Fab in both the
 * static and hover branches (verified against the installed @mui/material/Fab).
 */
function fab(base: object, extra: Record<string, unknown>): Partial<FabProps> {
  return { ...base, ...extra } as Partial<FabProps>;
}


// ── Hoisted static sx / props (no per-render allocation) ───────────────────

const DIAL_SX = {
  // The dial portals into the bottom-right anchor host, which already owns
  // position / safe-area insets; we only size the FAB down to match the HUD's
  // "start tiny" sizing default. `position: relative` anchors the collapsed
  // actions container we lift out of flow below.
  position: 'relative',
  '& .MuiSpeedDial-fab': {
    width: 48,
    height: 48,
    bgcolor: 'rgba(5,7,15,0.78)',
    color: '#dde',
    border: '1px solid rgba(255,255,255,0.16)',
    '&:hover': { bgcolor: 'rgba(5,7,15,0.9)' },
  },
  // When the dial is CLOSED, lift its actions container OUT of layout flow so
  // the dial's interactive bounding box collapses to just the 48px FAB. MUI
  // keeps the collapsed actions mounted (scale-0) for the open animation + the
  // `aria-pressed`-readable-when-collapsed contract, but a closed flex child at
  // scale(0) still reserves its full natural height — so each added action grew
  // the dial's box UPWARD, and the `pointer-events: auto` Slot wrapper around it
  // then intercepted taps meant for other corners. On the short iPhone-SE
  // landscape viewport (375px tall) the grown column reached the top-right
  // `drawer-toggle` and ate its click (Phase 4 WS-A1 added the spectator action;
  // `layout-slots.spec.ts` "floating MAP button …" caught it). Absolute + zero
  // height removes the reserved column without unmounting the actions (they stay
  // in the DOM, readable by attribute). The OPEN state (`.MuiSpeedDial-actions`
  // without `…-actionsClosed`) is untouched, so the expanded dial is unchanged.
  '& .MuiSpeedDial-actionsClosed': {
    position: 'absolute',
    bottom: 56,
    right: 4,
    height: 0,
    pointerEvents: 'none',
  },
  // The OPEN list fits the screen and scrolls (speedDialFit.ts).
  '& .MuiSpeedDial-actions:not(.MuiSpeedDial-actionsClosed)': FIT_OPEN_LIST_SX,
  // P3.1 — the always-on (tooltipOpen) action labels must NEVER wrap. The
  // static tooltip label defaults to a narrow max-width that wrapped longer
  // names ("Shield Pylon" etc.) onto two lines; force a single line with room
  // to breathe.
  '& .MuiSpeedDialAction-staticTooltipLabel': {
    whiteSpace: 'nowrap',
    maxWidth: 'none',
  },
} as const;

/** Downward variant: smaller FAB; the collapsed actions park BELOW it. */
const DIAL_SX_DOWN = {
  ...DIAL_SX,
  '& .MuiSpeedDial-fab': {
    ...DIAL_SX['& .MuiSpeedDial-fab'],
    width: 36,
    height: 36,
    minHeight: 36,
  },
  '& .MuiSpeedDial-actionsClosed': {
    position: 'absolute',
    top: 44,
    right: 0,
    height: 0,
    pointerEvents: 'none',
  },
} as const;

const FAB_PROPS = { size: 'small', 'data-testid': 'speed-dial-fab' } as const;

const ACTION_FAB_BASE = {
  size: 'small',
  sx: {
    width: 40,
    height: 40,
    bgcolor: 'rgba(5,7,15,0.85)',
    color: '#cde',
    border: '1px solid rgba(255,255,255,0.14)',
    '&:hover': { bgcolor: 'rgba(5,7,15,0.95)' },
  },
} as const;

const MENU_ACTION_FAB_PROPS = ACTION_FAB_BASE;
const WEAPON_ACTION_FAB_PROPS = ACTION_FAB_BASE;

// The Map action's tint reflects the open/closed overlay state (cyan when the
// galaxy overlay is open) so the dial mirrors the old MAP button affordance.
const MAP_ACTION_FAB_OPEN = {
  size: 'small',
  sx: {
    width: 40,
    height: 40,
    bgcolor: 'rgba(0, 220, 240, 0.22)',
    color: '#00eeff',
    border: '2px solid #00eeff',
    boxShadow: '0 0 12px rgba(0, 220, 240, 0.5)',
  },
} as const;

const MAP_ACTION_FAB_CLOSED = {
  size: 'small',
  sx: {
    width: 40,
    height: 40,
    bgcolor: 'rgba(0, 200, 220, 0.12)',
    color: 'rgba(0, 220, 240, 0.95)',
    border: '1.5px solid rgba(0, 200, 220, 0.55)',
  },
} as const;

function mapActionFabProps(open: boolean) {
  return open ? MAP_ACTION_FAB_OPEN : MAP_ACTION_FAB_CLOSED;
}
