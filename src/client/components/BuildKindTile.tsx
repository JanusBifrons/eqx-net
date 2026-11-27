/**
 * One kind on the Build sidebar's grid (BuildSidebar.tsx), drawn by the shared
 * `HullTile` (art="structure": the baked portrait, or the footprint silhouette)
 * so the Build menu, the Hangar and the shipyard share one tile look. Under the
 * picture: the build cost chip (◆, the catalogue `constructionCost`) and a power
 * chip (⚡ +N generates / −N draws at full load; none when 0). The packed stock
 * from `buildEntry` is the ×N badge, shown only when N > 0 (a kind that needs no
 * crate reads 0 but is buildable); a locked tile greys with a lock and says why.
 *
 * A tap picks the kind (unless locked) and always makes it the detail kind;
 * a desktop mouse hover does too. `BuildKindDetails` is the strip under the
 * grid that shows it: name, description, cost, power and any lock reason. On a
 * short (sideways phone) screen the strip is capped: the description clamps to
 * two lines and the stats stay on one, so the grid keeps its rows.
 */
import { memo } from 'react';
import { Box } from '@mui/material';
import { getStructureKind, type StructureKindId } from '@shared-types/structureKinds';
import { needsPackedCrate } from '@shared-types/blueprints';
import type { BuildEntry } from '@shared-types/packedStock';
import { HUD } from '../hud/tokens';
import { HullTile } from './HullTile';
import { shortQty } from './CostChips';
import { signed, structureSelfPower } from './structureSettingsPower';

/** A kind's power at full load, level 1, switched on: +output, −draw, 0 passive. */
export function buildKindPower(kindId: string): number {
  return Math.round(structureSelfPower(kindId, { level: 1, drawFull: true }));
}

/** Why a locked tile can't be placed, from the same rule `buildEntry` locks by;
 *  null when it is not locked. */
export function buildLockReason(kindId: string, entry: BuildEntry): string | null {
  if (!entry.locked) return null;
  return needsPackedCrate(kindId)
    ? `Needs a packed ${getStructureKind(kindId).displayName} crate in your hold or storage here`
    : 'Not available here';
}

export interface BuildKindTileProps {
  kindId: StructureKindId;
  entry: BuildEntry;
  onPick: (kind: StructureKindId) => void;
  /** This tile became the detail kind (a tap, or a desktop mouse hover). */
  onShow?: (kind: StructureKindId) => void;
  selected?: boolean;
  /** This room's name and blurb for the kind (`buildKindText`); null = the catalogue's. */
  text?: { name: string; description: string } | null;
}

export const BuildKindTile = memo(function BuildKindTile({ kindId, entry, onPick, onShow, selected = false, text = null }: BuildKindTileProps): JSX.Element {
  const k = getStructureKind(kindId);
  const name = text?.name ?? k.displayName;
  const power = buildKindPower(kindId);
  const reason = buildLockReason(kindId, entry);
  return (
    <HullTile
      art="structure"
      kind={kindId}
      name={name}
      testId={`build-${kindId}`}
      data={{ locked: entry.locked ? '1' : '0' }}
      edge={selected ? C.autoGlow : undefined}
      locked={entry.locked}
      badge={packedBadge(entry)}
      caption={reason !== null ? { text: 'Needs crate', color: C.inkDim } : undefined}
      tooltip={reason === null ? entry.label : `${name}: ${reason}`}
      onClick={() => { onShow?.(kindId); if (!entry.locked) onPick(kindId); }}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') onShow?.(kindId); }}
    >
      <Box sx={CHIPS_SX}>
        <Box component="span" sx={CHIP_SX} data-testid="build-cost-chip" data-n={k.constructionCost}>◆ {shortQty(k.constructionCost)}</Box>
        {power !== 0 && (
          <Box component="span" sx={{ ...CHIP_SX, color: power > 0 ? C.auto : C.inkDim }} data-testid="build-power-chip" data-n={power}>
            ⚡ {signedPower(power)}
          </Box>
        )}
      </Box>
    </HullTile>
  );
});

/** The tile's ×N badge: only for N > 0 on an unlocked tile. */
export function packedBadge(entry: BuildEntry): string | undefined {
  return entry.count !== null && entry.count > 0 && !entry.locked ? `×${entry.count}` : undefined;
}

/** "+35" / "−15" (a real minus sign, as the HUD shows it). */
function signedPower(n: number): string {
  return signed(n).replace('-', '−');
}

export interface BuildKindDetailsProps {
  kindId: StructureKindId | null;
  entry: BuildEntry | null;
  /** This room's name and blurb for the kind (`buildKindText`); null = the catalogue's. */
  text?: { name: string; description: string } | null;
}

/** The strip under the grid: the hovered or last tapped kind's details. */
export function BuildKindDetails({ kindId, entry, text = null }: BuildKindDetailsProps): JSX.Element {
  if (kindId === null || entry === null) {
    return <Box sx={DETAILS_SX} data-testid="build-details"><Box sx={DIM_SX}>Hover or tap a building for details.</Box></Box>;
  }
  const k = getStructureKind(kindId);
  const power = buildKindPower(kindId);
  const reason = buildLockReason(kindId, entry);
  const description = text?.description ?? k.description;
  return (
    <Box sx={DETAILS_SX} data-testid="build-details" data-kind={kindId}>
      <Box sx={DETAILS_NAME_SX}>{text?.name ?? k.displayName}</Box>
      {description !== '' && <Box sx={DESC_SX} data-testid="build-details-desc">{description}</Box>}
      <Box sx={STATS_SX}>
        <span data-testid="build-details-cost">◆ {k.constructionCost.toLocaleString('en-GB')}</span>
        {power !== 0 && <span data-testid="build-details-power">⚡ {signedPower(power)}</span>}
        {entry.count !== null && (entry.count > 0 || needsPackedCrate(kindId)) && (
          <span data-testid="build-details-packed">×{entry.count} packed</span>
        )}
      </Box>
      {reason !== null && <Box sx={LOCK_SX} data-testid="build-details-lock">🔒 {reason}</Box>}
    </Box>
  );
}

const C = HUD.color;
const CHIPS_SX = { display: 'flex', flexWrap: 'wrap', gap: '3px' } as const;
const CHIP_SX = {
  fontFamily: HUD.font.num, fontSize: 10, lineHeight: '15px', color: C.ink, px: '4px',
  border: `1px solid ${C.edge2}`, borderRadius: '3px', bgcolor: 'rgba(4,6,13,.6)', whiteSpace: 'nowrap',
} as const;
/** A short screen: a sideways phone (412 px tall), not a desktop window. */
export const SHORT_SCREEN_MQ = '@media (max-height: 500px)';
/** One line, cut with an ellipsis. */
const ONE_LINE = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;
/** Capped on a short screen (name, two description lines, stats, lock) so
 *  the grid above keeps ~1.5 tile rows and still scrolls. */
export const DETAILS_SX = {
  flex: 'none', borderTop: `1px solid ${C.panelEdge}`, p: '6px 8px', minHeight: 56,
  fontFamily: HUD.font.label, color: C.ink,
  [SHORT_SCREEN_MQ]: { minHeight: 0, maxHeight: 88, overflow: 'hidden', p: '4px 8px' },
} as const;
const DIM_SX = { fontSize: 11, color: C.inkDim } as const;
const DETAILS_NAME_SX = { fontSize: 12.5, fontWeight: 600, [SHORT_SCREEN_MQ]: ONE_LINE } as const;
export const DESC_SX = {
  fontSize: 11, color: C.inkDim, lineHeight: 1.3, mt: '2px',
  [SHORT_SCREEN_MQ]: { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' },
} as const;
export const STATS_SX = {
  display: 'flex', gap: '10px', mt: '4px', fontFamily: HUD.font.num, fontSize: 11,
  [SHORT_SCREEN_MQ]: { ...ONE_LINE, mt: '2px' },
} as const;
const LOCK_SX = { fontSize: 11, color: C.ink, mt: '4px', [SHORT_SCREEN_MQ]: { ...ONE_LINE, mt: '2px' } } as const;
