import { useCallback, useState, type ReactNode } from 'react';
import SpeedDial from '@mui/material/SpeedDial';
import SpeedDialAction from '@mui/material/SpeedDialAction';
import SpeedDialIcon from '@mui/material/SpeedDialIcon';
import type { FabProps } from '@mui/material/Fab';
import MenuIcon from '@mui/icons-material/Menu';
import MapIcon from '@mui/icons-material/Map';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import ConstructionIcon from '@mui/icons-material/Construction';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import HexagonIcon from '@mui/icons-material/Hexagon';
import HubIcon from '@mui/icons-material/Hub';
import SolarPowerIcon from '@mui/icons-material/SolarPower';
import DiamondIcon from '@mui/icons-material/Diamond';
import ShieldIcon from '@mui/icons-material/Shield';
import BatteryChargingFullIcon from '@mui/icons-material/BatteryChargingFull';
import SecurityIcon from '@mui/icons-material/Security';
import BoltIcon from '@mui/icons-material/Bolt';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import VisibilityIcon from '@mui/icons-material/Visibility';
import FlightIcon from '@mui/icons-material/Flight';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { getShipKind } from '@shared-types/shipKinds';
import { getStructureKind, type StructureKindId } from '@shared-types/structureKinds';
import {
  BUILD_CATEGORIES,
  CATEGORY_ICON,
  ROOT_VIEW,
  categoryById,
  goBackView,
  type BuildCategoryId,
  type DialView,
} from './buildCategories';
import { useTouchClickActivate } from './touchClickActivate';

/**
 * Consolidated bottom-right action menu (speed-dial UI refactor).
 *
 * A single MUI `SpeedDial` FAB that hosts the game's *discrete* (tap, not
 * held) HUD actions — what used to be scattered across the bottom-center MAP
 * button (`GalaxyMapToggleButton`), the bottom thumb-cluster weapon toggle
 * (`SlotSelector`), and the drawer toggle. The continuous/held controls
 * (joystick + FIRE + BOOST in `MobileControls`) deliberately stay as their own
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
 * Build tree (WS-13 / R2.6): the Build action drills a 3-level nav — main ▸
 * categories ▸ kinds — via the local `view` discriminated union (`buildCategories.tsx`).
 * The FAB stays the open/close toggle; a dedicated back ACTION pops one level; the
 * FAB icon reflects the drilled category at the `kinds` level. Picking a kind sets
 * `placementKind` and KEEPS the dial open (only a deliberate FAB toggle / Escape
 * closes it — `blur` / `mouseLeave` from clicking the canvas to position the ghost
 * are ignored in onClose), so several structures place in a row with no Build ▸
 * category re-drill (the old close-on-pick was the bug). Categories live client-side
 * only (no wire catalogue field, no version bump, no netgate).
 *
 * Perf: all static `sx` is hoisted to module-level consts (no per-render alloc,
 * per the drawer-perf rules). The dial's open/closed + drilled view are local
 * React state — pure presentation, never Zustand (invariant #2).
 */
export function SpeedDialMenu(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const isDead = useUIStore((s) => s.isDead);
  const phase = useUIStore((s) => s.phase);
  const pilotMode = useUIStore((s) => s.pilotMode);
  const setPilotMode = useUIStore((s) => s.setPilotMode);
  const isGalaxyMapOpen = useUIStore((s) => s.isGalaxyMapOpen);
  const setDrawerOpen = useUIStore((s) => s.setDrawerOpen);
  const toggleGalaxyMapOpen = useUIStore((s) => s.toggleGalaxyMapOpen);
  const activeSlotId = useUIStore((s) => s.activeSlotId);
  const shipKindId = useUIStore((s) => s.selectedShipKind);
  const setActiveSlotId = useUIStore((s) => s.setActiveSlotId);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);

  const [open, setOpen] = useState(false);
  // The dial's drilled view (pure presentation — local state, never Zustand).
  // Reset to ROOT whenever the dial closes so re-opening starts at the main menu.
  const [view, setView] = useState<DialView>(ROOT_VIEW);

  // Multitouch support (smoke handoff 2026-06-06). We drive the FAB + actions on
  // `onTouchStart` so a SECOND simultaneous touch opens/activates them; the
  // trailing synthesized click is dropped within the suppress window. `onClick`
  // stays live for desktop. Shared with `AutoFireToggleButton` (one impl).
  const { touchActivate, clickActivate, isWithinSuppressWindow } = useTouchClickActivate();

  const close = useCallback(() => {
    setOpen(false);
    setView(ROOT_VIEW);
    // Drop DOM focus from whatever speed-dial button the player just activated
    // (Map / Panels / Weapon). MUI Fab buttons activate on Space/Enter while
    // focused, so a still-focused Map FAB meant the next Space/Fire silently
    // re-toggled the galaxy overlay (WS-F #18). Blurring on close makes every
    // terminal selection lose focus.
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  const toggleOpen = useCallback(() => setOpen((o) => !o), []);

  const handleMenu = useCallback(() => {
    close();
    setDrawerOpen(true);
  }, [close, setDrawerOpen]);

  const handleMap = useCallback(() => {
    close();
    toggleGalaxyMapOpen();
  }, [close, toggleGalaxyMapOpen]);

  // Phase 4 WS-A1 (D7) — pilot↔spectator toggle. Spectator is a CLIENT-LOCAL
  // free-roam construction camera (D4/D5); the death→spectator transition fires
  // elsewhere (ColyseusClient.killEntity). This is the deliberate toggle. Gated
  // to phase==='game' below (it makes no sense on the galaxy/connecting screens).
  const handleSpectatorToggle = useCallback(() => {
    close();
    setPilotMode(useUIStore.getState().pilotMode === 'spectator' ? 'pilot' : 'spectator');
  }, [close, setPilotMode]);

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

  // Build-tree navigation — pure view transitions, the dial stays open.
  const enterCategories = useCallback(() => setView({ level: 'categories' }), []);
  const enterKinds = useCallback(
    (category: BuildCategoryId) => setView({ level: 'kinds', category }),
    [],
  );
  const goBack = useCallback(() => setView((v) => goBackView(v)), []);

  // Pick a kind to place: raise the placement ghost. Does NOT close the dial —
  // it STAYS OPEN at the kinds level so the player can place several structures
  // in a row (the old close() here reset to root, forcing a full Build ▸ category
  // ▸ kind re-drill for every structure — the R2.6 complaint). The onClose handler
  // ignores 'blur'/'mouseLeave', so clicking the canvas to position the ghost (or
  // the Confirm banner) doesn't dismiss the menu.
  const handlePickBuild = useCallback(
    (kind: StructureKindId) => {
      setPlacementKind(kind);
    },
    [setPlacementKind],
  );

  if (!shouldRender || isDead) return null;

  const slots = getShipKind(shipKindId).slots ?? [];
  const activeSlot = slots.find((s) => s.id === activeSlotId) ?? slots[0];
  const weaponLabel = activeSlot ? `Weapon: ${activeSlot.displayName}` : 'Weapon';

  // The back action — prepended at every non-root level. Pops one level (the FAB
  // never takes on the back role, so the open/close toggle is never overloaded).
  const backAction = (
    <SpeedDialAction
      key="back"
      icon={<ArrowBackIcon />}
      tooltipTitle="Back"
      tooltipOpen
      FabProps={fab(ACTION_FAB_BASE, {
        'data-testid': 'speed-dial-back',
        onClick: clickActivate(goBack),
        onTouchStart: touchActivate(goBack),
      })}
    />
  );

  let actions: ReactNode;
  if (view.level === 'categories') {
    actions = [
      backAction,
      ...BUILD_CATEGORIES.map((c) => (
        <SpeedDialAction
          key={c.id}
          icon={c.icon}
          tooltipTitle={c.label}
          tooltipOpen
          FabProps={fab(ACTION_FAB_BASE, {
            'data-testid': `build-cat-${c.id}`,
            onClick: clickActivate(() => enterKinds(c.id)),
            onTouchStart: touchActivate(() => enterKinds(c.id)),
          })}
        />
      )),
    ];
  } else if (view.level === 'kinds') {
    actions = [
      backAction,
      ...categoryById(view.category).kinds.map((kindId) => (
        <SpeedDialAction
          key={kindId}
          icon={BUILD_ICONS[kindId] ?? <ConstructionIcon />}
          tooltipTitle={getStructureKind(kindId).displayName}
          tooltipOpen
          FabProps={fab(ACTION_FAB_BASE, {
            'data-testid': `build-${kindId}`,
            onClick: clickActivate(() => handlePickBuild(kindId)),
            onTouchStart: touchActivate(() => handlePickBuild(kindId)),
          })}
        />
      )),
    ];
  } else {
    actions = [
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
      <SpeedDialAction
        key="build"
        icon={<ConstructionIcon />}
        tooltipTitle="Build ▸"
        tooltipOpen
        FabProps={fab(ACTION_FAB_BASE, {
          'data-testid': 'speed-dial-build',
          onClick: clickActivate(enterCategories),
          onTouchStart: touchActivate(enterCategories),
        })}
      />,
    ];
    // Phase 4 WS-A1 (D7) — the pilot↔spectator toggle is gated to the in-game
    // phase only (a free-roam construction camera makes no sense on the
    // galaxy-map / connecting screens, where the dial can still mount).
    if (phase === 'game') {
      const spectating = pilotMode === 'spectator';
      (actions as ReactNode[]).push(
        <SpeedDialAction
          key="spectator"
          icon={spectating ? <FlightIcon /> : <VisibilityIcon />}
          tooltipTitle={spectating ? 'Pilot ship' : 'Spectate'}
          tooltipOpen
          FabProps={fab(ACTION_FAB_BASE, {
            'data-testid': 'spectator-toggle',
            'aria-pressed': spectating,
            onClick: clickActivate(handleSpectatorToggle),
            onTouchStart: touchActivate(handleSpectatorToggle),
          })}
        />,
      );
    }
  }

  // The FAB reflects the drilled-into category at the `kinds` level (the dial
  // stays open there while placing, so a plain category icon shows the context);
  // otherwise the standard +/× SpeedDialIcon morph signals open/close.
  const fabIcon = view.level === 'kinds' ? CATEGORY_ICON[view.category] : <SpeedDialIcon />;

  return (
    <SpeedDial
      ariaLabel="Game actions"
      data-testid="speed-dial"
      icon={fabIcon}
      direction="up"
      open={open}
      // Ignore the MUI 'toggle' reason (its synthesized-click open/close) within
      // the suppression window — our `onTouchStart` already toggled `open`, so
      // letting the trailing click toggle again would immediately undo it.
      // Non-toggle reasons (focus / blur / escape / mouseLeave) still apply.
      onOpen={(_e, reason) => {
        if (reason === 'toggle' && isWithinSuppressWindow()) return;
        setOpen(true);
      }}
      // The dial STAYS OPEN across a placement (R2.6): picking a kind raises the
      // ghost but leaves the dial expanded so the next structure is one tap away.
      // MUI fires onClose on 'blur' / 'mouseLeave' too — e.g. when the player
      // clicks the canvas to position the ghost or taps the Confirm banner — and
      // we IGNORE those so an incidental focus change doesn't dismiss the build
      // menu. Only a deliberate FAB toggle or Escape closes it (resetting to the
      // root menu); the terminal actions (Panels/Map/Weapon) close via close().
      onClose={(_e, reason) => {
        if (reason === 'toggle') {
          if (isWithinSuppressWindow()) return;
          close();
        } else if (reason === 'escapeKeyDown') {
          close();
        }
        // 'blur' / 'mouseLeave' → ignored: the dial stays open.
      }}
      FabProps={{ ...FAB_PROPS, onTouchStart: touchActivate(toggleOpen) }}
      sx={DIAL_SX}
    >
      {actions}
    </SpeedDial>
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

/** Per-kind Build icon. */
/** Per-structure-kind build icon. Exported so the desktop RTS BottomControlPanel
 *  (Phase 5 WS-4) renders the same building glyphs as the speed-dial build drill. */
export const BUILD_ICONS: Record<StructureKindId, ReactNode> = {
  capital: <HexagonIcon />,
  connector: <HubIcon />,
  solar: <SolarPowerIcon />,
  miner: <DiamondIcon />,
  turret: <ShieldIcon />,
  battery: <BatteryChargingFullIcon />,
  shield_pylon: <SecurityIcon />,
  laser_bolt_turret: <BoltIcon />, // WS-8 (R2.15)
  missile_turret: <RocketLaunchIcon />,
};

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
  // P3.1 — the always-on (tooltipOpen) action labels must NEVER wrap. The
  // static tooltip label defaults to a narrow max-width that wrapped longer
  // names ("Shield Pylon" etc.) onto two lines; force a single line with room
  // to breathe.
  '& .MuiSpeedDialAction-staticTooltipLabel': {
    whiteSpace: 'nowrap',
    maxWidth: 'none',
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
