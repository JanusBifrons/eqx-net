import { Box } from '@mui/material';
import { phoneTiny } from './inspectorSizes';
import { StructureCardRows } from './structureCard';
import type { PanelData } from './EntityStatsPanel';

/**
 * Identity row of the click-to-inspect panel (`EntityStatsPanel`): a structure's
 * compact building card, or the entity name for everything else.
 */
export function EntityStatsHeader({ data }: { data: PanelData }): JSX.Element {
  return data.isStructure ? (
    // Building-panels A2 — the compact building card: badge, name, Lv, short
    // hull, power icon, one status chip (+ the "making" slot). Detail lives
    // in the Details panel's Settings section (StructureSettings.tsx).
    <StructureCardRows d={data} />
  ) : (
    <Box sx={NAME_SX} data-testid="entity-stats-name">{data.name}</Box>
  );
}

export const ELLIPSIS_SX = { overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, minWidth: 0 };
// Equinox Phase-5 audit — "WAY too small" on desktop: the sm breakpoint scales fonts,
// bar and icons ~2x; mobile (xs, and any phone: inspectorSizes.ts) stays tiny.
const NAME_SX = {
  gridColumn: '1 / -1',
  ...ELLIPSIS_SX,
  ...phoneTiny({ fontSize: [10, 20] }),
  fontWeight: 700,
  color: '#cde',
  letterSpacing: 0.3,
  whiteSpace: 'nowrap' as const,
};
