import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EqxTable, tableGridTemplate, type EqxTableColumn } from './EqxTable.js';
import { tablePageWindow } from './tablePaging.js';

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

  it('paging: shows one page, a pager only with more than one page, prev / next call onPageChange', () => {
    const onPage = vi.fn();
    const { rerender } = render(
      <EqxTable columns={COLS} rows={ROWS} rowKey={(r) => r.id} label="T" pageSize={2} page={0} onPageChange={onPage} data-testid="t" />,
    );
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByTestId('t-page')).toHaveTextContent('Page 1 of 3');
    expect(screen.getByTestId('t-prev')).toBeDisabled();
    fireEvent.click(screen.getByTestId('t-next'));
    expect(onPage).toHaveBeenCalledWith(1);
    rerender(<EqxTable columns={COLS} rows={ROWS} rowKey={(r) => r.id} label="T" pageSize={2} page={2} onPageChange={onPage} data-testid="t" />);
    expect(screen.getByTestId('t')).toHaveTextContent('Row 4');
    expect(screen.getByTestId('t-next')).toBeDisabled();
    fireEvent.click(screen.getByTestId('t-prev'));
    expect(onPage).toHaveBeenLastCalledWith(1);
    rerender(<EqxTable columns={COLS} rows={ROWS.slice(0, 2)} rowKey={(r) => r.id} label="T" pageSize={2} page={0} data-testid="t" />);
    expect(screen.queryByTestId('t-pager')).toBeNull();
  });

  it('empty: shows the empty node instead of rows', () => {
    render(<EqxTable columns={COLS} rows={[]} rowKey={(r) => r.id} label="T" empty="Nothing here" />);
    expect(screen.getByRole('table')).toHaveTextContent('Nothing here');
  });
});
