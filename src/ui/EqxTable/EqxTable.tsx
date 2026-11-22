/**
 * EqxTable: a compact sortable, paginated table for a panel (header like mock
 * `.sec`, rows a tighter `.lrow`). Values in, callbacks out; no game logic.
 * - Columns: a fixed `width` (px) or a `grow` share of the rest; `numeric`
 *   cells use the tabular number font; text cells ellipsize.
 * - Sorting: with `onSort` every `sortable` header is a button; a tap calls
 *   `onSort(id)` once. The caller owns the order: `sort` marks the primary
 *   column with an arrow (▲ asc, ▼ desc) and `aria-sort`.
 * - Rows: `onRowTap` makes each row an action (click, Enter or Space);
 *   `rowColor` tints a row's text, `rowDim` fades it, `rowSelected` washes it;
 *   `rowTestId` / `rowDataAttrs` for tests.
 * - Paging: with `pageSize` the table shows page `page` (0-based, clamped,
 *   `tablePageWindow`) and, when there is more than one page, a footer: a ◀
 *   arrow at the far left, ▶ at the far right (no labels; disabled at the
 *   ends) and numbered page buttons between them, the current one lit. Too
 *   many pages to fit: first, last, current ±1 and … gaps (`tablePageList`,
 *   at most 7 slots). Every button calls `onPageChange`.
 * - Does not position itself.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { Box } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';
import { tablePageList, tablePageWindow } from './tablePaging.js';

export type EqxSortDir = 'asc' | 'desc';

/** The primary sort the caller applied (marked with an arrow). */
export interface EqxTableSort {
  id: string;
  dir: EqxSortDir;
}

export interface EqxTableColumn<R> {
  id: string;
  /** Header text; also the sort button's accessible name. */
  label: string;
  /** Fixed width, px. */
  width?: number;
  /** Share of the width left after the fixed columns (default 1). Ignored with `width`. */
  grow?: number;
  /** Right-aligned cell and header. */
  alignRight?: boolean;
  /** Tabular number font. */
  numeric?: boolean;
  /** Default true; false = a plain header even with `onSort`. */
  sortable?: boolean;
  cell: (row: R) => ReactNode;
}

export interface EqxTableProps<R> {
  columns: readonly EqxTableColumn<R>[];
  rows: readonly R[];
  rowKey: (row: R) => string;
  /** The table's accessible name. */
  label: string;
  sort?: EqxTableSort | null;
  onSort?: (columnId: string) => void;
  onRowTap?: (row: R) => void;
  /** Accessible name of a tappable row. */
  rowLabel?: (row: R) => string;
  rowColor?: (row: R) => string | undefined;
  rowDim?: (row: R) => boolean;
  rowSelected?: (row: R) => boolean;
  rowTestId?: (row: R) => string;
  /** Extra `data-*` attributes per row (keys without the `data-` prefix). */
  rowDataAttrs?: (row: R) => Readonly<Record<string, string | number>>;
  /** Rows per page; omit for no paging. */
  pageSize?: number;
  page?: number;
  onPageChange?: (page: number) => void;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
  'data-testid'?: string;
}

const T = HUD.table;
const L = HUD.list;

const ROOT_SX = { display: 'flex', flexDirection: 'column', minWidth: 0, width: '100%' } as const;
const GRID_SX = { display: 'grid', alignItems: 'center', minWidth: 0 } as const;
const HEAD_ROW_SX = { ...GRID_SX, borderBottom: `1px solid ${HUD.color.edge2}` } as const;
const HEAD_CELL_SX = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  m: 0,
  py: `${T.headPadY}px`,
  px: `${T.cellPadX}px`,
  border: 0,
  bgcolor: 'transparent',
  color: HUD.color.inkFaint,
  fontFamily: HUD.font.label,
  fontSize: T.headFont,
  fontWeight: 400,
  letterSpacing: T.headTracking,
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textAlign: 'left',
} as const;
const LABEL_SX = { overflow: 'hidden', textOverflow: 'ellipsis' } as const;
const ARROW_SX = { ml: `${T.arrowGap}px`, flex: 'none' } as const;
const HEAD_BUTTON_SX = {
  ...HEAD_CELL_SX,
  width: '100%',
  cursor: 'pointer',
  '&:hover': { color: HUD.color.ink },
  '&:focus-visible': { outline: `1px solid ${HUD.color.auto}`, outlineOffset: -1 },
} as const;
const HEAD_SORTED_SX = { color: HUD.color.auto } as const;
const ROW_SX = {
  ...GRID_SX,
  borderBottom: `1px solid ${HUD.color.panelEdge}`,
  color: HUD.color.ink,
  fontFamily: HUD.font.label,
  fontSize: T.cellFont,
  transition: 'background .2s',
} as const;
const ROW_TAP_SX = {
  cursor: 'pointer',
  '&:hover, &:active': { bgcolor: L.rowHoverBg },
  '&:focus-visible': { outline: `1px solid ${HUD.color.auto}`, outlineOffset: -1 },
} as const;
const DIM_SX = { opacity: L.rowDimOpacity } as const;
const SELECTED_SX = { bgcolor: L.rowSelectedBg } as const;
const CELL_SX = {
  minWidth: 0,
  py: `${T.rowPadY}px`,
  px: `${T.cellPadX}px`,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;
const RIGHT_SX = { textAlign: 'right', justifyContent: 'flex-end' } as const;
const NUM_SX = { fontFamily: HUD.font.num, fontSize: T.smallFont } as const;
const EMPTY_SX = { py: `${L.rowPadY}px`, px: `${T.cellPadX}px`, color: HUD.color.inkDim, fontSize: T.cellFont } as const;
const FOOT_SX = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: `${T.pageGap}px`,
  pt: `${T.rowPadY}px`,
  pb: `${T.rowPadY}px`,
  // Pinned to the bottom of the scrolling panel body so the pager is always
  // in reach (a phone's 8 rows push it below the fold otherwise).
  position: 'sticky',
  bottom: 0,
  bgcolor: HUD.color.sidePanelBg,
  fontFamily: HUD.font.num,
  fontSize: T.smallFont,
  color: HUD.color.inkDim,
} as const;
const PAGES_SX = { display: 'flex', alignItems: 'center', gap: `${T.pageGap}px`, minWidth: 0 } as const;
const PAGE_BTN_SX = {
  minWidth: T.pageBtn,
  height: T.pageBtn,
  px: '3px',
  m: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1px solid ${HUD.color.edge2}`,
  borderRadius: `${HUD.panel.radius}px`,
  bgcolor: 'transparent',
  color: HUD.color.ink,
  fontFamily: HUD.font.num,
  fontSize: T.smallFont,
  lineHeight: 1,
  cursor: 'pointer',
  '&:hover:not(:disabled)': { bgcolor: HUD.color.panel },
  '&:focus-visible': { outline: `1px solid ${HUD.color.auto}`, outlineOffset: 1 },
  '&:disabled': { opacity: HUD.panel.offOpacity, cursor: 'default' },
} as const;
const PAGE_CURRENT_SX = { bgcolor: HUD.color.auto, borderColor: HUD.color.auto, color: HUD.color.onAccent, '&:hover:not(:disabled)': { bgcolor: HUD.color.auto } } as const;
const GAP_SX = { minWidth: T.pageBtn, textAlign: 'center' } as const;

/** `grid-template-columns` for the columns: fixed px, else a share of the rest. */
export function tableGridTemplate(columns: readonly { width?: number; grow?: number }[]): string {
  return columns.map((c) => (c.width !== undefined ? `${c.width}px` : `minmax(0, ${c.grow ?? 1}fr)`)).join(' ');
}

function dataProps(attrs: Readonly<Record<string, string | number>> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (attrs === undefined) return out;
  for (const k of Object.keys(attrs)) out[`data-${k}`] = attrs[k]!;
  return out;
}

export function EqxTable<R>({
  columns, rows, rowKey, label, sort = null, onSort, onRowTap, rowLabel, rowColor, rowDim, rowSelected,
  rowTestId, rowDataAttrs, pageSize, page = 0, onPageChange, empty, 'data-testid': testId,
}: EqxTableProps<R>) {
  const template = { gridTemplateColumns: tableGridTemplate(columns) };
  const win = pageSize !== undefined ? tablePageWindow(rows.length, page, pageSize) : null;
  const shown = win ? rows.slice(win.start, win.end) : rows;
  const sub = (s: string) => (testId ? `${testId}-${s}` : undefined);

  return (
    <Box sx={ROOT_SX} data-testid={testId}>
      <Box role="table" aria-label={label} sx={ROOT_SX}>
        <Box role="row" sx={[HEAD_ROW_SX, template]}>
          {columns.map((c) => {
            const sorted = sort !== null && sort.id === c.id;
            const ariaSort = sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
            const text = (
              <>
                <Box component="span" sx={LABEL_SX}>{c.label}</Box>
                {sorted && <Box component="span" aria-hidden sx={ARROW_SX}>{sort.dir === 'asc' ? '▲' : '▼'}</Box>}
              </>
            );
            const canSort = onSort !== undefined && c.sortable !== false;
            return (
              <Box key={c.id} role="columnheader" aria-sort={ariaSort} sx={{ minWidth: 0 }}>
                {canSort ? (
                  <Box component="button" type="button" aria-label={c.label} onClick={() => onSort(c.id)}
                    sx={[HEAD_BUTTON_SX, c.alignRight === true && RIGHT_SX, sorted && HEAD_SORTED_SX]}
                    data-testid={sub(`sort-${c.id}`)} data-sorted={sorted ? sort.dir : undefined}>
                    {text}
                  </Box>
                ) : (
                  <Box sx={[HEAD_CELL_SX, c.alignRight === true && RIGHT_SX]}>{text}</Box>
                )}
              </Box>
            );
          })}
        </Box>
        {shown.length === 0 && empty !== undefined && <Box sx={EMPTY_SX}>{empty}</Box>}
        {shown.map((r) => {
          const tap = onRowTap;
          const onKey = tap === undefined ? undefined : (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap(r); }
          };
          const color = rowColor?.(r);
          return (
            <Box
              key={rowKey(r)}
              role="row"
              tabIndex={tap === undefined ? undefined : 0}
              aria-label={rowLabel?.(r)}
              onClick={tap === undefined ? undefined : () => tap(r)}
              onKeyDown={onKey}
              sx={[ROW_SX, template, tap !== undefined && ROW_TAP_SX, rowDim?.(r) === true && DIM_SX,
                rowSelected?.(r) === true && SELECTED_SX, color !== undefined && { color }]}
              data-testid={rowTestId?.(r)}
              {...dataProps(rowDataAttrs?.(r))}
            >
              {columns.map((c) => (
                <Box key={c.id} role="cell" sx={[CELL_SX, c.alignRight === true && RIGHT_SX, c.numeric === true && NUM_SX]}>
                  {c.cell(r)}
                </Box>
              ))}
            </Box>
          );
        })}
      </Box>
      {win !== null && win.pages > 1 && (
        <Box component="nav" aria-label={`${label} pages`} sx={FOOT_SX} data-testid={sub('pager')}>
          <Box component="button" type="button" aria-label="Previous page" sx={PAGE_BTN_SX}
            onClick={() => onPageChange?.(win.page - 1)} disabled={win.page === 0} data-testid={sub('prev')}>◀</Box>
          <Box sx={PAGES_SX} data-testid={sub('page')} data-page={win.page} data-pages={win.pages}>
            {tablePageList(win.page, win.pages).map((p) => (typeof p === 'number' ? (
              <Box key={p} component="button" type="button" aria-label={`Page ${p + 1}`}
                aria-current={p === win.page ? 'page' : undefined}
                sx={[PAGE_BTN_SX, p === win.page && PAGE_CURRENT_SX]}
                onClick={() => onPageChange?.(p)} data-testid={sub(`page-${p + 1}`)}>{p + 1}</Box>
            ) : (
              <Box key={p} component="span" aria-hidden sx={GAP_SX}>…</Box>
            )))}
          </Box>
          <Box component="button" type="button" aria-label="Next page" sx={PAGE_BTN_SX}
            onClick={() => onPageChange?.(win.page + 1)} disabled={win.page >= win.pages - 1} data-testid={sub('next')}>▶</Box>
        </Box>
      )}
    </Box>
  );
}
