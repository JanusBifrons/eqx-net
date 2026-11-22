import { useState, useSyncExternalStore } from 'react';
import { Box, IconButton } from '@mui/material';
import RotateRightIcon from '@mui/icons-material/RotateRight';
import FlipIcon from '@mui/icons-material/Flip';
import CheckIcon from '@mui/icons-material/Check';
import { useUIStore } from '../state/store';
import { cyclePlacementRotation, getPlacementMirror, togglePlacementMirror } from '../structures/structurePlacementClient';
import { isTouchDevice } from '../input/TouchInput';
import { getPlacementHeld, getPlacementRejection, subscribePlacementHeld, subscribePlacementRejection } from '../structures/placementChosen';
import { Slot } from '../layout/Slot';
import { PlacementFenceHint } from './PlacementFenceHint';
import { PlacementLinkHint } from './PlacementLinkHint';
import { commitPlacement } from '../structures/placementCancel';

/**
 * The placing bar (speed-dial-resource-structures plan, Phase 2; restyled by
 * the placing-bar stream, owner design 2026-11-22).
 *
 * Shown only while the player is in placement (build) mode (`placementKind`
 * set by the Build menu). The renderer draws a translucent blueprint GHOST
 * (`RenderMirror.pendingPlacementPreview`); this bar is its touch controls:
 * Place sends `place_structure` through `commitPlacement`; Rotate turns the
 * ghost a quarter turn through `cyclePlacementRotation` (the desktop R key);
 * Mirror flips it through `togglePlacementMirror` (the desktop F key).
 * Cancel is not here: the picked-building strip's ✕ (`BuildPlacingStrip`)
 * stops placing.
 *
 * ── Docked bottom-middle, fixed size ──
 * Three icon buttons, no text, so the bar is the same width for every
 * building. It sits in the `bottom-center` Slot at order 4, above the
 * status capsule (3): bottom hosts are column-reverse. The "why" line(s)
 * (the docked `PlacementLinkHint` / `PlacementFenceHint`) stack ABOVE the bar
 * in the same dock; the dock grows upward from the bottom, so a hint never
 * resizes or moves the bar.
 *
 * Static `sx` hoisted (drawer-perf rule).
 */
export function StructurePlacementBanner(): JSX.Element | null {
  const placementKind = useUIStore((s) => s.placementKind);
  // The mirror choice is module state; this only re-renders the pressed look.
  const [, bumpMirror] = useState(0);
  // The ghost's verdict (the server's own placement rule): blocked ⇒ Confirm
  // is disabled, the reason line under the banner says why.
  const rejected = useSyncExternalStore(subscribePlacementRejection, getPlacementRejection) !== null;
  // Right after Place the next ghost waits dim on the spot just sent (held).
  const held = useSyncExternalStore(subscribePlacementHeld, getPlacementHeld);
  const blocked = rejected || held;

  // TOUCH-ONLY affordance (P3.6 / WS-C4b). The bar is the two-step
  // tap-to-position → Place flow for touch devices. On DESKTOP the one-click
  // model (hover-follow + left-click places, R / F rotate and mirror,
  // right-click / Escape cancels — WS-10) needs no bar, so it is gated off
  // for pointer devices. The desktop "placement
  // active" E2E signal is `data-placement-screen-x` (published by gameRafLoop
  // on both render paths), NOT this banner.
  if (!placementKind || !isTouchDevice()) return null;

  const onConfirm = (): void => {
    // Commit at the pointer-chosen world point via the ONE path the desktop
    // click uses too (`commitPlacement`): you KEEP placing the same building
    // until Cancel, except a place-once kind or the last crate (build-menu M3).
    // A refused commit (the ghost went red) keeps placement open too.
    commitPlacement(placementKind);
  };
  // Same quarter-turn the desktop R key applies; the renderer reads it through
  // the placement preview's angle, so no React state changes here.
  const onRotate = (): void => {
    cyclePlacementRotation();
  };
  const mirrored = getPlacementMirror();
  const onMirror = (): void => {
    togglePlacementMirror();
    bumpMirror((n) => n + 1);
  };

  return (
    <Slot anchor="bottom-center" order={4}>
      <Box data-testid="placement-dock" sx={DOCK_SX}>
        <PlacementFenceHint docked />
        <PlacementLinkHint docked />
        <Box data-testid="placement-banner" data-kind={placementKind} sx={BANNER_SX}>
          <IconButton data-testid="placement-confirm" aria-label="Place" title="Place" onClick={onConfirm} disabled={blocked} sx={CONFIRM_SX}>
            <CheckIcon fontSize="small" />
          </IconButton>
          <IconButton data-testid="placement-rotate" aria-label="Rotate" title="Rotate" onClick={onRotate} sx={ROTATE_SX}>
            <RotateRightIcon fontSize="small" />
          </IconButton>
          <IconButton data-testid="placement-mirror" aria-label="Mirror" title="Mirror" aria-pressed={mirrored} onClick={onMirror} sx={mirrored ? MIRROR_ON_SX : ROTATE_SX}>
            <FlipIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>
    </Slot>
  );
}

/** The "why" line(s) stacked above the bar; the bar stays last (bottom). */
const DOCK_SX = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 0.5,
  maxWidth: 'calc(100vw - 16px)',
} as const;

/** Three 40 px buttons, two 4 px gaps, 4 px padding and a 1 px border each side. */
export const PLACING_BAR_WIDTH_PX = 3 * 40 + 2 * 4 + 2 * 4 + 2;

const BANNER_SX = {
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  boxSizing: 'border-box',
  width: PLACING_BAR_WIDTH_PX,
  flexShrink: 0,
  gap: '4px',
  p: '4px',
  borderRadius: 1,
  bgcolor: 'rgba(5,7,15,0.82)',
  border: '1px solid rgba(120,200,255,0.35)',
} as const;

// Every button is a 40 px square touch target (a quarter-turn is tapped
// repeatedly while lining a building up); the colour says what it does.
const ICON_BTN_SX = {
  boxSizing: 'border-box',
  width: 40,
  height: 40,
  flexShrink: 0,
  borderRadius: 1,
  border: '1px solid',
} as const;

const ROTATE_SX = { ...ICON_BTN_SX, color: '#9fd8ff', borderColor: 'rgba(120,200,255,0.45)' } as const;

const MIRROR_ON_SX = { ...ROTATE_SX, bgcolor: 'rgba(120,200,255,0.18)', borderColor: 'rgba(120,200,255,0.8)' } as const;

const CONFIRM_SX = {
  ...ICON_BTN_SX, color: '#00ff88', borderColor: 'rgba(0,255,136,0.5)',
  // Blocked ghost: a dimmed tick (MUI's default disabled grey is invisible on the dark dock).
  '&.Mui-disabled': { color: 'rgba(0,255,136,0.25)', borderColor: 'rgba(0,255,136,0.15)' },
} as const;
