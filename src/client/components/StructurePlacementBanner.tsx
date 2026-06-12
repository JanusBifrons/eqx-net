import { Box, Button } from '@mui/material';
import { useUIStore } from '../state/store';
import { getStructureKind } from '@shared-types/structureKinds';
import { commitChosenPlacement } from '../structures/structurePlacementClient';

/**
 * Placement confirm banner (speed-dial-resource-structures plan, Phase 2;
 * world-anchored in the smoke handoff 2026-06-06, Issue 5).
 *
 * Shown only while the player is in placement mode (`placementKind` set by the
 * speed-dial Build menu). The renderer draws a translucent blueprint GHOST at
 * the ahead-of-ship world pose (`RenderMirror.pendingPlacementPreview`); this
 * banner is the Confirm/Cancel affordance anchored OVER that ghost. Confirm
 * sends `place_structure`; Cancel exits placement mode.
 *
 * ── World-anchoring (Issue 5) ──
 * The banner is `position:fixed` at a HIGH z-index, rendered OUTSIDE the Slot
 * system. The old `bottom-center` Slot sat at `Z.hud` (10) — UNDER the
 * `Z.mobileControls` (15) thumb cluster + speed-dial on a phone, so Confirm was
 * occluded and un-tappable (the user's "it's under the UI" report). Now
 * `gameRafLoop` moves it each frame to the renderer's projected on-screen
 * position of the ghost (`RendererFeedback.placementScreenX/Y` →
 * `data-placement-screen-x/y`), via a direct-DOM style write (no per-frame
 * React re-render — invariant #2). The `top/left` below are the pre-projection
 * fallback (e.g. before the first frame, or if the ghost projects off-screen).
 *
 * Static `sx` hoisted (drawer-perf rule).
 */
export function StructurePlacementBanner(): JSX.Element | null {
  const placementKind = useUIStore((s) => s.placementKind);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);

  if (!placementKind) return null;
  const kind = getStructureKind(placementKind);

  const onConfirm = (): void => {
    // Commit at the pointer-chosen world point via the shared path (production
    // `placementChosen` channel — NOT the webdriver-gated dataset; smoke
    // 2026-06-07 capture kuytvy). Identical to the WS-10 desktop one-click place.
    commitChosenPlacement(placementKind);
    setPlacementKind(null);
  };
  const onCancel = (): void => setPlacementKind(null);

  return (
    <Box data-testid="placement-banner" sx={BANNER_SX}>
      <Box sx={LABEL_SX}>Place {kind.displayName} here?</Box>
      <Button
        size="small"
        data-testid="placement-confirm"
        onClick={onConfirm}
        sx={CONFIRM_SX}
      >
        Confirm
      </Button>
      <Button
        size="small"
        data-testid="placement-cancel"
        onClick={onCancel}
        sx={CANCEL_SX}
      >
        Cancel
      </Button>
    </Box>
  );
}

const BANNER_SX = {
  // World-anchored: position:fixed at a z-tier ABOVE the HUD controls (15),
  // drawer (1200), and overlay (1400) so Confirm is always hit-testable on
  // mobile. gameRafLoop overwrites left/top each frame from the projected
  // ghost position; these are the fallback (centred, lower third).
  position: 'fixed',
  left: '50%',
  top: '66%',
  // Sit just ABOVE the anchor point (the ghost) and horizontally centre on it.
  transform: 'translate(-50%, calc(-100% - 12px))',
  zIndex: 1450,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 0.75,
  px: 1,
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

const CONFIRM_SX = {
  fontSize: 11,
  py: 0.25,
  color: '#00ff88',
  borderColor: 'rgba(0,255,136,0.5)',
} as const;

const CANCEL_SX = {
  fontSize: 11,
  py: 0.25,
  color: 'rgba(255,120,120,0.95)',
} as const;
