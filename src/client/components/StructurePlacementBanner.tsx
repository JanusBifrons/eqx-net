import { Box, Button } from '@mui/material';
import { useUIStore } from '../state/store';
import { getStructureKind } from '@shared-types/structureKinds';
import { placeStructureAhead } from '../structures/structurePlacementClient';

/**
 * Placement confirm banner (speed-dial-resource-structures plan, Phase 2).
 *
 * Shown only while the player is in placement mode (`placementKind` set by the
 * speed-dial Build menu). It is the lightweight "blueprint ghost" for the first
 * cut: rather than a Pixi world overlay that follows the cursor (which needs the
 * render-worker camera transform), it confirms a drop a fixed clearance AHEAD of
 * the ship. Confirm sends `place_structure`; Cancel exits placement mode.
 *
 * The full tap-to-position world ghost (translucent silhouette + connection-
 * range ring + live valid/invalid tint) is a follow-up that layers onto the
 * same `placeStructureAhead` / `place_structure` send.
 *
 * Static `sx` hoisted (drawer-perf rule). Mounted via a `bottom-center` Slot.
 */
export function StructurePlacementBanner(): JSX.Element | null {
  const placementKind = useUIStore((s) => s.placementKind);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);

  if (!placementKind) return null;
  const kind = getStructureKind(placementKind);

  const onConfirm = (): void => {
    placeStructureAhead(placementKind);
    setPlacementKind(null);
  };
  const onCancel = (): void => setPlacementKind(null);

  return (
    <Box data-testid="placement-banner" sx={BANNER_SX}>
      <Box sx={LABEL_SX}>Place {kind.displayName} ahead?</Box>
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
