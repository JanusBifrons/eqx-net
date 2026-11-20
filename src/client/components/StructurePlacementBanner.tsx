import { Box, IconButton } from '@mui/material';
import RotateRightIcon from '@mui/icons-material/RotateRight';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import { useUIStore } from '../state/store';
import { getStructureKind } from '@shared-types/structureKinds';
import { commitChosenPlacement, cyclePlacementRotation } from '../structures/structurePlacementClient';
import { isTouchDevice } from '../input/TouchInput';
import { Slot } from '../layout/Slot';
import { PlacementFenceHint } from './PlacementFenceHint';
import { PlacementLinkHint } from './PlacementLinkHint';

/**
 * Placement confirm banner (speed-dial-resource-structures plan, Phase 2).
 *
 * Shown only while the player is in placement (build) mode (`placementKind`
 * set by the Build menu). The renderer draws a translucent blueprint GHOST
 * (`RenderMirror.pendingPlacementPreview`); this banner is its Confirm/Cancel
 * affordance. Confirm sends `place_structure`; Cancel exits placement mode.
 * Rotate turns the ghost a quarter turn through the same
 * `cyclePlacementRotation` the desktop R key uses.
 *
 * ── Docked top-centre (build mode, owner design 2026-11-20) ──
 * Build mode switches to the Command view and hides the flight controls
 * (`buildModeView.ts`, `GameHud`), so the banner no longer chases the ghost
 * (world-anchored, it ran off a sideways phone's edge). It sits in the
 * `top-center` Slot column, first in order, with the "why" line(s) (the docked
 * `PlacementLinkHint` / `PlacementFenceHint`) right under it in the same block.
 *
 * Icon-only buttons (owner 2026-11-20: "just like a tick, cross or rotate icon
 * to save space"): rotate, tick (confirm, green), cross (cancel, red), each a
 * 40 px touch target with an aria-label and title, so the dock fits a sideways
 * phone between the Fly/Command/Build switch and the speed dial.
 *
 * Static `sx` hoisted (drawer-perf rule).
 */
export function StructurePlacementBanner(): JSX.Element | null {
  const placementKind = useUIStore((s) => s.placementKind);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);

  // TOUCH-ONLY affordance (P3.6 / WS-C4b). The banner is the two-step
  // tap-to-position → Confirm/Cancel flow for touch devices. On DESKTOP the
  // one-click model (hover-follow + left-click places, right-click / Escape
  // cancels — WS-10) needs no banner, so showing the mobile Confirm/Cancel on
  // desktop is wrong ("the desktop placement still shows the Confirm/Cancel
  // from mobile"). Gate it off for pointer devices. The desktop "placement
  // active" E2E signal is `data-placement-screen-x` (published by gameRafLoop
  // on both render paths), NOT this banner.
  if (!placementKind || !isTouchDevice()) return null;
  const kind = getStructureKind(placementKind);

  const onConfirm = (): void => {
    // Commit at the pointer-chosen world point via the shared path (production
    // `placementChosen` channel — NOT the webdriver-gated dataset; smoke
    // 2026-06-07 capture kuytvy). Identical to the WS-10 desktop one-click place.
    commitChosenPlacement(placementKind);
    setPlacementKind(null);
  };
  const onCancel = (): void => setPlacementKind(null);
  // Same quarter-turn the desktop R key applies; the renderer reads it through
  // the placement preview's angle, so no React state changes here.
  const onRotate = (): void => {
    cyclePlacementRotation();
  };

  return (
    <Slot anchor="top-center" order={-1}>
      <Box data-testid="placement-dock" sx={DOCK_SX}>
        <Box data-testid="placement-banner" sx={BANNER_SX}>
          <Box sx={LABEL_SX}>Place {kind.displayName} here?</Box>
          <IconButton data-testid="placement-rotate" aria-label="Rotate" title="Rotate" onClick={onRotate} sx={ROTATE_SX}>
            <RotateRightIcon fontSize="small" />
          </IconButton>
          <IconButton data-testid="placement-confirm" aria-label="Confirm" title="Confirm" onClick={onConfirm} sx={CONFIRM_SX}>
            <CheckIcon fontSize="small" />
          </IconButton>
          <IconButton data-testid="placement-cancel" aria-label="Cancel" title="Cancel" onClick={onCancel} sx={CANCEL_SX}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
        <PlacementFenceHint docked />
        <PlacementLinkHint docked />
      </Box>
    </Slot>
  );
}

/** The banner + its "why" line(s), stacked in the top-centre column. */
const DOCK_SX = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 0.5,
  maxWidth: 'calc(100vw - 16px)',
} as const;

const BANNER_SX = {
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
  pl: 1,
  pr: 0.5,
  py: 0.5,
  borderRadius: 1,
  bgcolor: 'rgba(5,7,15,0.82)',
  border: '1px solid rgba(120,200,255,0.35)',
  color: '#cde',
  fontSize: 11,
  fontFamily: 'monospace',
  whiteSpace: 'nowrap',
} as const;

const LABEL_SX = { fontWeight: 700, letterSpacing: 0.3 } as const;

// Every button is a 40 px square touch target (a quarter-turn is tapped
// repeatedly while lining a building up); the colour says what it does.
const ICON_BTN_SX = {
  width: 40,
  height: 40,
  borderRadius: 1,
  border: '1px solid',
} as const;

const ROTATE_SX = { ...ICON_BTN_SX, color: '#9fd8ff', borderColor: 'rgba(120,200,255,0.45)' } as const;

const CONFIRM_SX = { ...ICON_BTN_SX, color: '#00ff88', borderColor: 'rgba(0,255,136,0.5)' } as const;

const CANCEL_SX = { ...ICON_BTN_SX, color: 'rgba(255,120,120,0.95)', borderColor: 'rgba(255,120,120,0.45)' } as const;
