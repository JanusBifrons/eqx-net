/**
 * The Build sidebar folded while placing (BuildSidebar.tsx in strip mode, the
 * SidePanel `BUILD_STRIP_SIZE`): the picked building's portrait (the shared
 * HullTile, art="structure"), its name, and a ✕ that cancels placing. A tap on
 * the portrait expands back to the full sidebar; placement stays live.
 */
import { Box } from '@mui/material';
import { getStructureKind, type StructureKindId } from '@shared-types/structureKinds';
import { HUD } from '../hud/tokens';
import { HullTile } from './HullTile';
import { WINDOW_X_SX } from './GameWindow';

export interface BuildPlacingStripProps {
  kind: StructureKindId;
  /** Portrait tap: back to the full sidebar. */
  onExpand: () => void;
  /** ✕: cancel placing. */
  onCancel: () => void;
}

export function BuildPlacingStrip({ kind, onExpand, onCancel }: BuildPlacingStripProps): JSX.Element {
  const name = getStructureKind(kind).displayName;
  return (
    <Box sx={STRIP_SX} data-testid="build-strip" data-kind={kind}>
      <Box component="button" type="button" sx={X_SX} onClick={onCancel} aria-label="Cancel placing"
        data-testid="build-strip-cancel">✕</Box>
      <HullTile art="structure" kind={kind} name={name} testId="build-strip-portrait" tooltip="Open the Build menu"
        onClick={onExpand} />
    </Box>
  );
}

const STRIP_SX = { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '4px', p: '6px' } as const;
const X_SX = {
  ...WINDOW_X_SX, alignSelf: 'flex-end', width: 26, height: 26, fontSize: 13, color: HUD.color.ink,
} as const;
