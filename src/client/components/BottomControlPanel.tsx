import { memo, useCallback, useEffect } from 'react';
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
 * click selects it for placement. While piloting it is hidden (mounted, see below): the
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

// Per-state cell styles, hoisted (sx-hoist rule): a cell's sx is one of three
// module-level objects, so a re-render serialises no new style object.
const CELL_EMPTY_SX = { ...CELL_BASE, color: 'rgba(255,255,255,0.28)', borderColor: 'rgba(255,255,255,0.12)', bgcolor: 'transparent' } as const;
const CELL_ACTIVE_SX = { ...CELL_BASE, color: '#00ff88', borderColor: '#00ff88', bgcolor: 'rgba(0,255,136,0.14)' } as const;
const CELL_IDLE_SX = { ...CELL_BASE, color: '#cfe', borderColor: 'rgba(255,255,255,0.18)', bgcolor: 'rgba(255,255,255,0.04)' } as const;

const ROW_HIDDEN_SX = { ...ROW_SX, display: 'none' } as const;

interface BuildCellProps {
  kind: StructureKindId;
  /** 1-based number-key hotkey. */
  num: number;
  label: string;
  active: boolean;
  /** Economy v2 — a non-starter kind with no packed one here: greyed, unpickable. */
  locked: boolean;
  onPick: (kind: StructureKindId) => void;
}

/**
 * One palette square. Memoised on primitive props, so a palette re-render (the
 * spectator flip, a packed-stock reply, a new placement pick) re-renders only
 * the cells whose label / lock / active state changed.
 */
const BuildCell = memo(function BuildCell({ kind, num, label, active, locked, onPick }: BuildCellProps): JSX.Element {
  const onClick = useCallback(() => {
    if (!locked) onPick(kind);
  }, [kind, locked, onPick]);
  return (
    <Tooltip title={label} placement="top">
      <Box
        role="button"
        data-testid={`bcp-cell-build:${kind}`}
        data-active={active ? '1' : '0'}
        aria-pressed={active}
        onClick={onClick}
        sx={locked ? CELL_EMPTY_SX : active ? CELL_ACTIVE_SX : CELL_IDLE_SX}
      >
        <Box component="span" sx={NUM_SX}>{num}</Box>
        {BUILD_ICONS[kind]}
        <Box component="span" sx={CELL_LABEL_SX}>{label}</Box>
      </Box>
    </Tooltip>
  );
});

/**
 * The palette is MOUNTED for the whole desktop game and only SHOWN while
 * spectating (`display: none`, `data-panel-mode="hidden"` while piloting). It
 * used to mount on death: ~40 cells of MUI Tooltip + Popper + Box + icon (~860
 * components) cold-mounted in the same task as the destroy message, a 50–70 ms
 * frame stall at the moment the ship explodes (2026-11-10 player-view clips,
 * `tests/perf/death-spectator-hitch.spec.ts`). Pre-mounted, the death flip
 * re-renders only the row (the memoised cells are unchanged) and inserts no
 * DOM. Lock: `BottomControlPanel.test.tsx` "the spectator flip inserts no DOM".
 */
export function BottomControlPanel(): JSX.Element | null {
  const phase = useUIStore((s) => s.phase);
  const spectating = useUIStore((s) => s.pilotMode === 'spectator');
  const placementKind = useUIStore((s) => s.placementKind);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);

  const inGame = phase === 'game' && !isTouchDevice();
  const showing = inGame && spectating;
  // Economy v2 — packed-structure stock, asked for only while the row shows.
  const packedStock = usePackedStock(showing);

  // Number-key (1..9) building selection while spectating. Desktop-only +
  // in-game; ignores keystrokes while a text field has focus so it never
  // hijacks typing. Piloting leaves 1–9 to the weapon groups.
  useEffect(() => {
    if (!showing) return;
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
  }, [showing, setPlacementKind, packedStock]);

  if (!inGame || BUILDINGS.length === 0) return null;

  return (
    <Box
      sx={showing ? ROW_SX : ROW_HIDDEN_SX}
      aria-hidden={!showing}
      data-testid="bottom-control-panel"
      data-panel-mode={showing ? 'build' : 'hidden'}
    >
      {BUILDINGS.map((k, i) => {
        const entry = buildEntry(k, packedStock);
        return (
          <BuildCell
            key={k}
            kind={k}
            num={i + 1}
            label={entry.label}
            active={placementKind === k}
            locked={entry.locked}
            onPick={setPlacementKind}
          />
        );
      })}
    </Box>
  );
}
