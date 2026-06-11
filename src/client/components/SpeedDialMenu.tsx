import { useCallback, useState, type ReactNode } from 'react';
import SpeedDial from '@mui/material/SpeedDial';
import SpeedDialAction from '@mui/material/SpeedDialAction';
import SpeedDialIcon from '@mui/material/SpeedDialIcon';
import MenuIcon from '@mui/icons-material/Menu';
import MapIcon from '@mui/icons-material/Map';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import ConstructionIcon from '@mui/icons-material/Construction';
import HexagonIcon from '@mui/icons-material/Hexagon';
import HubIcon from '@mui/icons-material/Hub';
import SolarPowerIcon from '@mui/icons-material/SolarPower';
import DiamondIcon from '@mui/icons-material/Diamond';
import ShieldIcon from '@mui/icons-material/Shield';
import BatteryChargingFullIcon from '@mui/icons-material/BatteryChargingFull';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { getShipKind } from '@shared-types/shipKinds';
import { STRUCTURE_KINDS_LIST, type StructureKindId } from '@shared-types/structureKinds';
import { useTouchClickActivate } from './touchClickActivate';

/**
 * Consolidated bottom-right action menu (speed-dial UI refactor, Phase 1).
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
 * desktop (smoke handoff 2026-06-06, Issue 3 — "the speed dial is in the wrong
 * place" → corner). The dial expands UPWARD (`direction="up"`) so its actions
 * grow away from the bottom bezel.
 *
 * Multitouch (same handoff): MUI `SpeedDial` opens via a synthesized CLICK,
 * which mobile browsers only emit for the PRIMARY touch — so a second
 * simultaneous touch (tapping the dial while the joystick is held) never
 * opened it. The FAB + each action therefore also bind `onTouchStart` (the raw
 * touch IS delivered to a second touch point, exactly like FIRE/BOOST in
 * MobileControls), with a short post-touch click-suppression window so the
 * trailing synthesized click doesn't double-fire the action (the
 * AutoFireToggleButton double-toggle trap). `onClick` is kept for desktop.
 *
 * Phase 2 will append a "Build ▸" set of structure-placement actions here.
 *
 * Perf: all static `sx` is hoisted to module-level consts (no per-render alloc,
 * per the drawer-perf rules). The dial's open/closed state is local React
 * state — it is pure presentation and never belongs in Zustand.
 */
export function SpeedDialMenu(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const isDead = useUIStore((s) => s.isDead);
  const isGalaxyMapOpen = useUIStore((s) => s.isGalaxyMapOpen);
  const setDrawerOpen = useUIStore((s) => s.setDrawerOpen);
  const toggleGalaxyMapOpen = useUIStore((s) => s.toggleGalaxyMapOpen);
  const activeSlotId = useUIStore((s) => s.activeSlotId);
  const shipKindId = useUIStore((s) => s.selectedShipKind);
  const setActiveSlotId = useUIStore((s) => s.setActiveSlotId);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);

  const [open, setOpen] = useState(false);
  // `build` swaps the dial's actions to the structure-kind picker (a "Build ▸"
  // sub-menu, since MUI SpeedDial doesn't nest). Reset whenever the dial closes.
  const [buildMode, setBuildMode] = useState(false);

  // Multitouch support (smoke handoff 2026-06-06, Issue 3). We drive the FAB +
  // actions on `onTouchStart` so a SECOND simultaneous touch (the dial tapped
  // while a steering joystick touch is held) opens/activates them — mobile
  // browsers only synthesize a `click` for the PRIMARY touch sequence, so the
  // pure-MUI click path never fired for the second touch. The trailing
  // synthesized click is dropped within the suppress window (the
  // AutoFireToggleButton double-fire trap); `onClick` stays live for desktop.
  // Shared with `AutoFireToggleButton` via `useTouchClickActivate` (one impl).
  const { touchActivate, clickActivate, isWithinSuppressWindow } = useTouchClickActivate();

  const close = useCallback(() => {
    setOpen(false);
    setBuildMode(false);
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

  // Enter the Build sub-menu (keep the dial open so the kind actions show).
  const handleBuild = useCallback(() => setBuildMode(true), []);

  const handlePickBuild = useCallback(
    (kind: StructureKindId) => {
      setPlacementKind(kind);
      close();
    },
    [close, setPlacementKind],
  );

  if (!shouldRender || isDead) return null;

  const slots = getShipKind(shipKindId).slots ?? [];
  const activeSlot = slots.find((s) => s.id === activeSlotId) ?? slots[0];
  const weaponLabel = activeSlot ? `Weapon: ${activeSlot.displayName}` : 'Weapon';

  return (
    <SpeedDial
      ariaLabel="Game actions"
      data-testid="speed-dial"
      icon={<SpeedDialIcon />}
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
      onClose={(_e, reason) => {
        if (reason === 'toggle' && isWithinSuppressWindow()) return;
        close();
      }}
      FabProps={{ ...FAB_PROPS, onTouchStart: touchActivate(toggleOpen) }}
      sx={DIAL_SX}
    >
      {buildMode
        ? STRUCTURE_KINDS_LIST.map((k) => (
            <SpeedDialAction
              key={k.id}
              icon={BUILD_ICONS[k.id] ?? <ConstructionIcon />}
              tooltipTitle={`Build ${k.displayName}`}
              data-testid={`build-${k.id}`}
              onClick={clickActivate(() => handlePickBuild(k.id))}
              FabProps={{ ...ACTION_FAB_BASE, onTouchStart: touchActivate(() => handlePickBuild(k.id)) }}
            />
          ))
        : [
            <SpeedDialAction
              key="menu"
              icon={<MenuIcon />}
              tooltipTitle="Panels"
              data-testid="speed-dial-menu"
              onClick={clickActivate(handleMenu)}
              FabProps={{ ...MENU_ACTION_FAB_PROPS, onTouchStart: touchActivate(handleMenu) }}
            />,
            <SpeedDialAction
              key="map"
              icon={<MapIcon />}
              tooltipTitle="Map"
              data-testid="galaxy-map-toggle"
              aria-pressed={isGalaxyMapOpen}
              onClick={clickActivate(handleMap)}
              FabProps={{ ...mapActionFabProps(isGalaxyMapOpen), onTouchStart: touchActivate(handleMap) }}
            />,
            <SpeedDialAction
              key="weapon"
              icon={<GpsFixedIcon />}
              tooltipTitle={weaponLabel}
              data-testid="slot-selector"
              data-slot-id={activeSlot?.id}
              onClick={clickActivate(handleWeapon)}
              FabProps={{ ...WEAPON_ACTION_FAB_PROPS, onTouchStart: touchActivate(handleWeapon) }}
            />,
            <SpeedDialAction
              key="build"
              icon={<ConstructionIcon />}
              tooltipTitle="Build ▸"
              data-testid="speed-dial-build"
              onClick={clickActivate(handleBuild)}
              FabProps={{ ...ACTION_FAB_BASE, onTouchStart: touchActivate(handleBuild) }}
            />,
          ]}
    </SpeedDial>
  );
}

/** Per-kind Build icon. */
const BUILD_ICONS: Record<StructureKindId, ReactNode> = {
  capital: <HexagonIcon />,
  connector: <HubIcon />,
  solar: <SolarPowerIcon />,
  miner: <DiamondIcon />,
  turret: <ShieldIcon />,
  battery: <BatteryChargingFullIcon />,
};

// ── Hoisted static sx / props (no per-render allocation) ───────────────────

const DIAL_SX = {
  // The dial portals into the bottom-right anchor host, which already owns
  // position / safe-area insets; we only size the FAB down to match the HUD's
  // "start tiny" sizing default.
  '& .MuiSpeedDial-fab': {
    width: 48,
    height: 48,
    bgcolor: 'rgba(5,7,15,0.78)',
    color: '#dde',
    border: '1px solid rgba(255,255,255,0.16)',
    '&:hover': { bgcolor: 'rgba(5,7,15,0.9)' },
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
