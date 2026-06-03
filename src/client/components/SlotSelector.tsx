import { useCallback } from 'react';
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { getShipKind } from '@shared-types/shipKinds';

/**
 * Weapon-SLOT selector (weapons/energy/AI overhaul §5.2) — replaces the old
 * per-weapon `WeaponSelector`. Each ship fires its catalogue-bound loadout;
 * the pilot picks which *slot* is hot. Today every gameplay ship has exactly
 * one slot, so the group renders a single selected toggle (forward-compatible
 * with multi-slot ships).
 *
 * Correct MUI patterns (per the plan + the drawer-perf rules):
 *  - all static `sx` hoisted to module-level consts (no per-render alloc);
 *  - `onChange` via `useCallback`, ignoring the exclusive-deselect `null`;
 *  - narrow Zustand selectors so unrelated store changes don't re-render;
 *  - no manual `addEventListener` (so nothing to leak).
 */
const GROUP_SX = {
  bgcolor: 'rgba(0,0,0,0.5)',
  borderRadius: 1,
};
const BUTTON_SX = {
  px: 1,
  py: 0.25,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: 'uppercase' as const,
  color: 'rgba(255,255,255,0.6)',
  border: '1px solid rgba(255,255,255,0.2)',
  '&.Mui-selected': {
    color: '#ffc23d',
    bgcolor: 'rgba(255,194,61,0.12)',
    borderColor: '#ffc23d',
    boxShadow: '0 0 8px rgba(255,194,61,0.4)',
  },
  '&.Mui-selected:hover': {
    bgcolor: 'rgba(255,194,61,0.18)',
  },
};

export function SlotSelector(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const isDead = useUIStore((s) => s.isDead);
  const activeSlotId = useUIStore((s) => s.activeSlotId);
  const shipKindId = useUIStore((s) => s.selectedShipKind);
  const setActiveSlotId = useUIStore((s) => s.setActiveSlotId);

  const handleChange = useCallback(
    (_e: React.MouseEvent<HTMLElement>, next: string | null) => {
      // Exclusive group: ignore the deselect (`null`) so a slot stays hot.
      if (next !== null) setActiveSlotId(next);
    },
    [setActiveSlotId],
  );

  if (!shouldRender || isDead) return null;
  const slots = getShipKind(shipKindId).slots ?? [];
  if (slots.length === 0) return null;
  // A single-slot ship shows one (always-selected) toggle — keep it for the
  // affordance "this is the hot slot", forward-compatible with multi-slot.
  return (
    <ToggleButtonGroup
      data-testid="slot-selector"
      exclusive
      size="small"
      value={activeSlotId}
      onChange={handleChange}
      sx={GROUP_SX}
    >
      {slots.map((slot) => (
        <ToggleButton key={slot.id} value={slot.id} sx={BUTTON_SX} data-slot-id={slot.id}>
          {slot.displayName}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
