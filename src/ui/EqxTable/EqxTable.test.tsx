import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { EqxTable, tableGridTemplate, type EqxTableColumn } from './EqxTable.js';
import { tablePageList, tablePageWindow } from './tablePaging.js';

interface Row { id: string; name: string; km: number }
const COLS: EqxTableColumn<Row>[] = [
  { id: 'name', label: 'Name', cell: (r) => r.name },
  { id: 'km', label: 'Dist', width: 40, alignRight: true, numeric: true, cell: (r) => `${r.km} km` },
];
const ROWS: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}`, km: i }));

describe('tablePageWindow', () => {
  it('slices pages and clamps the page into range', () => {
    expect(tablePageWindow(5, 0, 2)).toEqual({ page: 0, pages: 3, start: 0, end: 2 });
    expect(tablePageWindow(5, 2, 2)).toEqual({ page: 2, pages: 3, start: 4, end: 5 });
    expect(tablePageWindow(5, 9, 2)).toEqual({ page: 2, pages: 3, start: 4, end: 5 });
    expect(tablePageWindow(5, -1, 2).page).toBe(0);
    expect(tablePageWindow(0, 3, 8)).toEqual({ page: 0, pages: 1, start: 0, end: 0 });
  });
});

describe('tablePageList', () => {
  // 1-based for reading: pages shown to the player.
  const shown = (page: number, pages: number): string => tablePageList(page - 1, pages)
    .map((p) => (typeof p === 'number' ? String(p + 1) : '…')).join(' ');

  it('every page when they fit in 7 slots', () => {
    expect(shown(1, 1)).toBe('1');
    expect(shown(3, 5)).toBe('1 2 3 4 5');
    expect(shown(7, 7)).toBe('1 2 3 4 5 6 7');
  });

  it('too many: first, last, the current page and its neighbours, a gap mark between', () => {
    expect(shown(5, 12)).toBe('1 … 4 5 6 … 12');
    expect(shown(8, 12)).toBe('1 … 7 8 9 … 12');
  });

  it('near an end the window fills toward it, so there are always 7 slots', () => {
    expect(shown(1, 12)).toBe('1 2 3 4 5 … 12');
    expect(shown(4, 12)).toBe('1 2 3 4 5 … 12');
    expect(shown(9, 12)).toBe('1 … 8 9 10 11 12');
    expect(shown(12, 12)).toBe('1 … 8 9 10 11 12');
    expect(shown(5, 8)).toBe('1 … 4 5 6 7 8');
    for (let n = 8; n <= 30; n++) for (let p = 1; p <= n; p++) {
      const list = tablePageList(p - 1, n);
      expect(list).toHaveLength(7);
      expect(list).toContain(p - 1);
      expect(list[0]).toBe(0);
      expect(list[6]).toBe(n - 1);
    }
  });

  it('gap marks are distinct (usable as React keys)', () => {
    const gaps = tablePageList(5, 12).filter((p) => typeof p !== 'number');
    expect(gaps).toEqual(['gap-start', 'gap-end']);
  });
});

describe('tableGridTemplate', () => {
  it('fixed px, else a share of the rest', () => {
    expect(tableGridTemplate([{ grow: 2 }, { width: 40 }, {}])).toBe('minmax(0, 2fr) 40px minmax(0, 1fr)');
  });
});

describe('EqxTable', () => {
  it('a named table with header cells and rows; forwards data-testid', () => {
    render(<EqxTable columns={COLS} rows={ROWS} rowKey={(r) => r.id} label="Things" data-testid="t" />);
    expect(screen.getByRole('table', { name: 'Things' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getAllByRole('row')).toHaveLength(6);
    expect(screen.getByTestId('t')).toHaveTextContent('Row 4');
    // No onSort: plain headers, no buttons.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a header tap calls onSort once; the sorted column shows its arrow and aria-sort', () => {
    const onSort = vi.fn();
    const { rerender } = render(
      <EqxTable columns={COLS} rows={ROWS} rowKey={(r) => r.id} label="T" sort={{ id: 'km', dir: 'asc' }} onSort={onSort} data-testid="t" />,
    );
    const km = screen.getByTestId('t-sort-km');
    expect(km).toHaveTextContent('▲');
    expect(km.getAttribute('data-sorted')).toBe('asc');
    expect(km.parentElement!.getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getByTestId('t-sort-name').parentElement!.getAttribute('aria-sort')).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(onSort).toHaveBeenCalledWith('name');
    rerender(<EqxTable columns={COLS} rows={ROWS} rowKey={(r) => r.id} label="T" sort={{ id: 'km', dir: 'desc' }} onSort={onSort} data-testid="t" />);
    expect(screen.getByTestId('t-sort-km')).toHaveTextContent('▼');
  });

  it('sortable: false keeps a plain header', () => {
    const cols: EqxTableColumn<Row>[] = [{ ...COLS[0]!, sortable: false }, COLS[1]!];
    render(<EqxTable columns={cols} rows={ROWS} rowKey={(r) => r.id} label="T" onSort={() => {}} data-testid="t" />);
    expect(screen.queryByTestId('t-sort-name')).toBeNull();
    expect(screen.getByTestId('t-sort-km')).toBeTruthy();
  });

  it('onRowTap: click, Enter and Space tap a row; row colour, dim, test ids and data attrs', () => {
    const onTap = vi.fn();
    render(
      <EqxTable columns={COLS} rows={ROWS} rowKey={(r) => r.id} label="T" onRowTap={onTap}
        rowLabel={(r) => r.name} rowColor={(r) => (r.km === 1 ? 'rgb(255, 0, 0)' : undefined)}
        rowDim={(r) => r.km === 2} rowTestId={(r) => `row-${r.id}`} rowDataAttrs={(r) => ({ key: r.id, km: r.km })} />,
    );
    const row = screen.getByTestId('row-r1');
    expect(row.getAttribute('aria-label')).toBe('Row 1');
    expect(row.getAttribute('data-key')).toBe('r1');
    expect(row.getAttribute('data-km')).toBe('1');
    expect(getComputedStyle(row).color).toBe('rgb(255, 0, 0)');
    expect(getComputedStyle(screen.getByTestId('row-r2')).opacity).toBe('0.6');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    fireEvent.keyDown(row, { key: 'a' });
    expect(onTap).toHaveBeenCalledTimes(3);
    expect(onTap).toHaveBeenCalledWith(ROWS[1]);
  });

  it('paging: one page shown; a pager only with more than one page; arrows and page numbers call onPageChange', () => {
    const onPage = vi.fn();
    const { rerender } = render(
      <EqxTable columns={COLS} rows={ROWS} rowKey={(r) => r.id} label="T" pageSize={2} page={0} onPageChange={onPage} data-testid="t" />,
    );
    expect(screen.getAllByRole('row')).toHaveLength(3);
    const pages = screen.getByTestId('t-page');
    expect(pages.getAttribute('data-page')).toBe('0');
    expect(pages.getAttribute('data-pages')).toBe('3');
    // Arrows only: no text, named for screen readers.
    const prev = screen.getByTestId('t-prev');
    const next = screen.getByTestId('t-next');
    expect(prev.getAttribute('aria-label')).toBe('Previous page');
    expect(next.getAttribute('aria-label')).toBe('Next page');
    expect(prev.textContent).not.toMatch(/prev/i);
    expect(next.textContent).not.toMatch(/next/i);
    expect(screen.getByTestId('t-pager')).not.toHaveTextContent('Page');
    expect(prev).toBeDisabled();
    // Numbered buttons between the arrows; the current one is marked.
    expect(within(pages).getAllByRole('button').map((b) => b.textContent)).toEqual(['1', '2', '3']);
    expect(screen.getByTestId('t-page-1').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('t-page-2').getAttribute('aria-current')).toBeNull();
    fireEvent.click(next);
    expect(onPage).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByTestId('t-page-3'));
    expect(onPage).toHaveBeenLastCalledWith(2);
    rerender(<EqxTable columns={COLS} rows={ROWS} rowKey={(r) => r.id} label="T" pageSize={2} page={2} onPageChange={onPage} data-testid="t" />);
    expect(screen.getByTestId('t')).toHaveTextContent('Row 4');
    expect(screen.getByTestId('t-next')).toBeDisabled();
    expect(screen.getByTestId('t-page-3').getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByTestId('t-prev'));
    expect(onPage).toHaveBeenLastCalledWith(1);
    rerender(<EqxTable columns={COLS} rows={ROWS.slice(0, 2)} rowKey={(r) => r.id} label="T" pageSize={2} page={0} data-testid="t" />);
    expect(screen.queryByTestId('t-pager')).toBeNull();
  });

  it('many pages: first, last, current and neighbours, with gap marks', () => {
    const many: Row[] = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, name: `M ${i}`, km: i }));
    render(<EqxTable columns={COLS} rows={many} rowKey={(r) => r.id} label="T" pageSize={2} page={4} onPageChange={() => {}} data-testid="t" />);
    expect(screen.getByTestId('t-page').textContent).toBe('1…456…12');
    expect(within(screen.getByTestId('t-page')).getAllByRole('button')).toHaveLength(5);
  });

  it('empty: shows the empty node instead of rows', () => {
    render(<EqxTable columns={COLS} rows={[]} rowKey={(r) => r.id} label="T" empty="Nothing here" />);
    expect(screen.getByRole('table')).toHaveTextContent('Nothing here');
  });
});
