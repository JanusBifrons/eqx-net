import { useEffect, type ReactNode } from 'react';
import { Box, Tooltip } from '@mui/material';
import { useUIStore } from '../state/store';
import { type StructureKindId } from '@shared-types/structureKinds';
import { BUILD_CATEGORIES } from './buildCategories';
import { BUILD_ICONS } from './SpeedDialMenu';
import { buildEntry } from '@shared-types/packedStock';
import { usePackedStock } from '../structures/usePackedStock';
import { isTouchDevice } from '../input/TouchInput';

/**
 * Phase 5 WS-4 — the DESKTOP RTS-style bottom build palette, shown while
 * SPECTATING: the flattened BUILDING palette (every structure kind, no category
 * hierarchy) as labelled squares with corner number-key badges; number key /
 * click selects it for placement. While piloting it renders nothing: the
 * weapon strip (fire control) replaced the old weapon-slot row, and 1–9 select
 * weapon GROUPS there (MouseLock.ts `installFcKeys`).
 *
 * DESKTOP-ONLY (`!isTouchDevice()`) — mobile keeps the speed-dial untouched. The
 * panel reuses the SAME discrete store action the speed-dial drives
 * (`setPlacementKind`), so it's a parallel control surface, not a new
 * mechanism. All store reads are discrete enums/ids (Invariant #2).
 */

/** The building palette, flattened in category order (Core → Economy → Defence). */
const BUILDINGS: readonly StructureKindId[] = BUILD_CATEGORIES.flatMap((c) => c.kinds);

interface PanelCell {
  key: string;
  /** 1-based number-key hotkey, or null for a non-selectable empty slot. */
  num: number | null;
  label: string;
  icon: ReactNode;
  active: boolean;
  empty: boolean;
  onSelect: (() => void) | null;
}

const ROW_SX = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 0.75,
  px: 1,
  py: 0.5,
  bgcolor: 'rgba(6,9,18,0.72)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 1.5,
  backdropFilter: 'blur(3px)',
} as const;

const CELL_BASE = {
  position: 'relative' as const,
  width: 56,
  height: 56,
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
  gap: '2px',
  borderRadius: 1,
  border: '1px solid',
  cursor: 'pointer',
  userSelect: 'none' as const,
  '& .MuiSvgIcon-root': { fontSize: 22 },
} as const;

const CELL_LABEL_SX = {
  fontSize: 8,
  lineHeight: 1,
  maxWidth: 52,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  textTransform: 'uppercase' as const,
  letterSpacing: 0.3,
} as const;

const NUM_SX = {
  position: 'absolute' as const,
  top: 1,
  left: 3,
  fontSize: 9,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.55)',
  lineHeight: 1,
} as const;

function cellColors(cell: PanelCell): { color: string; borderColor: string; bgcolor: string } {
  if (cell.empty) return { color: 'rgba(255,255,255,0.28)', borderColor: 'rgba(255,255,255,0.12)', bgcolor: 'transparent' };
  if (cell.active) return { color: '#00ff88', borderColor: '#00ff88', bgcolor: 'rgba(0,255,136,0.14)' };
  return { color: '#cfe', borderColor: 'rgba(255,255,255,0.18)', bgcolor: 'rgba(255,255,255,0.04)' };
}

export function BottomControlPanel(): JSX.Element | null {
  const phase = useUIStore((s) => s.phase);
  const pilotMode = useUIStore((s) => s.pilotMode);
  const placementKind = useUIStore((s) => s.placementKind);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);

  const spectating = pilotMode === 'spectator';
  // Economy v2 — packed-structure stock while the build row is showing.
  const packedStock = usePackedStock(phase === 'game' && spectating && !isTouchDevice());

  // Number-key (1..9) building selection while spectating. Desktop-only +
  // in-game; ignores keystrokes while a text field has focus so it never
  // hijacks typing.
  useEffect(() => {
    if (phase !== 'game' || isTouchDevice() || !spectating) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const b = BUILDINGS[n - 1];
      if (b && !buildEntry(b, packedStock).locked) setPlacementKind(b);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, spectating, setPlacementKind, packedStock]);

  if (phase !== 'game' || isTouchDevice() || !spectating) return null;

  const cells: PanelCell[] = [];
  if (spectating) {
    BUILDINGS.forEach((k, i) => {
      // Economy v2 — a non-starter kind with no packed one here is greyed out.
      const entry = buildEntry(k, packedStock);
      cells.push({
        key: `build:${k}`,
        num: i + 1,
        label: entry.label,
        icon: BUILD_ICONS[k],
        active: placementKind === k,
        empty: entry.locked,
        onSelect: entry.locked ? null : () => setPlacementKind(k),
      });
    });
  }

  if (cells.length === 0) return null;

  return (
    <Box sx={ROW_SX} data-testid="bottom-control-panel" data-panel-mode="build">
      {cells.map((cell) => {
        const c = cellColors(cell);
        return (
          <Tooltip key={cell.key} title={cell.label} placement="top">
            <Box
              role="button"
              data-testid={`bcp-cell-${cell.key}`}
              data-active={cell.active ? '1' : '0'}
              aria-pressed={cell.active}
              onClick={cell.onSelect ?? undefined}
              sx={{ ...CELL_BASE, color: c.color, borderColor: c.borderColor, bgcolor: c.bgcolor }}
            >
              {cell.num !== null && <Box component="span" sx={NUM_SX}>{cell.num}</Box>}
              {cell.icon}
              <Box component="span" sx={CELL_LABEL_SX}>{cell.label}</Box>
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}
