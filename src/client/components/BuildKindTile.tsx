/**
 * One kind on the Build sidebar's grid (BuildSidebar.tsx): its icon, its name
 * and the packed-stock line from `buildEntry` (×N, or a lock when the kind
 * needs a packed one and there is none). A locked tile does nothing on tap.
 *
 * A deliberately small placeholder: the portrait tiles replace this component
 * in a later slice, with the same props.
 */
import { memo } from 'react';
import { Box } from '@mui/material';
import ConstructionIcon from '@mui/icons-material/Construction';
import LockIcon from '@mui/icons-material/Lock';
import { getStructureKind, type StructureKindId } from '@shared-types/structureKinds';
import type { BuildEntry } from '@shared-types/packedStock';
import { HUD } from '../hud/tokens';
import { BUILD_ICONS } from './buildIcons';

export interface BuildKindTileProps {
  kindId: StructureKindId;
  entry: BuildEntry;
  onPick: (kind: StructureKindId) => void;
}

export const BuildKindTile = memo(function BuildKindTile({ kindId, entry, onPick }: BuildKindTileProps): JSX.Element {
  return (
    <Box
      component="button"
      type="button"
      data-testid={`build-${kindId}`}
      data-locked={entry.locked ? '1' : '0'}
      aria-disabled={entry.locked}
      title={entry.label}
      onClick={entry.locked ? undefined : () => onPick(kindId)}
      sx={entry.locked ? TILE_LOCKED_SX : TILE_SX}
    >
      <Box sx={ICON_SX}>{BUILD_ICONS[kindId] ?? <ConstructionIcon />}</Box>
      <Box sx={NAME_SX}>{getStructureKind(kindId).displayName}</Box>
      {entry.locked
        ? <LockIcon sx={LOCK_SX} data-testid="build-tile-lock" />
        : entry.count !== null && <Box sx={COUNT_SX}>×{entry.count}</Box>}
    </Box>
  );
});

const C = HUD.color;
const TILE_SX = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
  minWidth: 0, p: '6px 4px', cursor: 'pointer', color: C.ink,
  bgcolor: 'rgba(5,7,15,0.85)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '4px',
  fontFamily: HUD.font.label,
  '&:hover': { bgcolor: 'rgba(52,216,255,0.12)', borderColor: C.autoGlow },
} as const;
const TILE_LOCKED_SX = { ...TILE_SX, opacity: 0.45, cursor: 'default', '&:hover': {} } as const;
const ICON_SX = { display: 'flex', '& svg': { fontSize: 24 } } as const;
const NAME_SX = {
  fontSize: 10, lineHeight: 1.2, textAlign: 'center', width: '100%',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
} as const;
const COUNT_SX = { fontSize: 10, color: C.auto, fontFamily: HUD.font.num } as const;
const LOCK_SX = { fontSize: 12, color: C.inkDim } as const;
