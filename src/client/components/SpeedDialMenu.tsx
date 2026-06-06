import { useCallback, useState } from 'react';
import SpeedDial from '@mui/material/SpeedDial';
import SpeedDialAction from '@mui/material/SpeedDialAction';
import SpeedDialIcon from '@mui/material/SpeedDialIcon';
import MenuIcon from '@mui/icons-material/Menu';
import MapIcon from '@mui/icons-material/Map';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { getShipKind } from '@shared-types/shipKinds';

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
 * Placement: it portals into the `bottom-right` anchor at a HIGH `order` so on
 * touch it sits to the LEFT of the existing FIRE/BOOST cluster (which keep
 * their corner positions unchanged — orders 10/20 in the row-reverse anchor);
 * on desktop, where there is no thumb cluster, it simply sits in the corner.
 * The dial expands UPWARD (`direction="up"`) so its actions grow away from the
 * bottom bezel.
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

  const [open, setOpen] = useState(false);

  const handleMenu = useCallback(() => {
    setOpen(false);
    setDrawerOpen(true);
  }, [setDrawerOpen]);

  const handleMap = useCallback(() => {
    setOpen(false);
    toggleGalaxyMapOpen();
  }, [toggleGalaxyMapOpen]);

  const handleWeapon = useCallback(() => {
    setOpen(false);
    // Cycle to the next weapon slot on the local ship. Today every gameplay
    // ship has exactly one slot, so this is a no-op affordance that still
    // surfaces "this is your hot slot"; it becomes a real cycle the moment a
    // multi-slot kind ships.
    const slots = getShipKind(shipKindId).slots ?? [];
    if (slots.length === 0) return;
    const idx = slots.findIndex((s) => s.id === activeSlotId);
    const next = slots[(idx + 1) % slots.length];
    if (next) setActiveSlotId(next.id);
  }, [shipKindId, activeSlotId, setActiveSlotId]);

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
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      FabProps={FAB_PROPS}
      sx={DIAL_SX}
    >
      <SpeedDialAction
        icon={<MenuIcon />}
        tooltipTitle="Panels"
        data-testid="speed-dial-menu"
        onClick={handleMenu}
        FabProps={MENU_ACTION_FAB_PROPS}
      />
      <SpeedDialAction
        icon={<MapIcon />}
        tooltipTitle="Map"
        data-testid="galaxy-map-toggle"
        aria-pressed={isGalaxyMapOpen}
        onClick={handleMap}
        FabProps={mapActionFabProps(isGalaxyMapOpen)}
      />
      <SpeedDialAction
        icon={<GpsFixedIcon />}
        tooltipTitle={weaponLabel}
        data-testid="slot-selector"
        data-slot-id={activeSlot?.id}
        onClick={handleWeapon}
        FabProps={WEAPON_ACTION_FAB_PROPS}
      />
    </SpeedDial>
  );
}

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
