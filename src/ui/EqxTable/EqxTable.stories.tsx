import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { eqxTheme } from '../theme.js';
import { EqxTable, type EqxTableColumn, type EqxTableSort } from './EqxTable.js';

/** EQX catalogue: a compact sortable, paginated table (the Contacts panel's). */
interface Row { id: string; name: string; type: string; side: string; km: number; colour: string }
const ROWS: Row[] = [
  { id: 'a', name: 'Fighter', type: 'Ship', side: 'Drones', km: 1.2, colour: '#ff6b6b' },
  { id: 'b', name: 'Frigate', type: 'Ship', side: 'Robots', km: 4.4, colour: '#ff6b6b' },
  { id: 'c', name: 'Trade station', type: 'Structure', side: 'Traders', km: 3.1, colour: '#ffd479' },
  { id: 'd', name: 'Fighter', type: 'Ship', side: 'Ripley', km: 0.6, colour: '#6bff9b' },
  { id: 'e', name: 'Turret', type: 'Structure', side: 'Vasquez', km: 9.8, colour: '#6bff9b' },
];
const COLS: EqxTableColumn<Row>[] = [
  { id: 'name', label: 'Name', grow: 1.4, cell: (r) => r.name },
  { id: 'type', label: 'Type', width: 46, cell: (r) => r.type },
  { id: 'side', label: 'Faction', grow: 1, cell: (r) => r.side },
  { id: 'km', label: 'Dist', width: 46, alignRight: true, numeric: true, cell: (r) => `${r.km} km` },
];

function Interactive({ pageSize }: { pageSize?: number }) {
  const [sort, setSort] = useState<EqxTableSort>({ id: 'km', dir: 'asc' });
  const [page, setPage] = useState(0);
  const key = sort.id as keyof Row;
  const rows = [...ROWS].sort((a, b) => {
    const c = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
    return sort.dir === 'asc' ? c : -c;
  });
  return (
    <EqxTable columns={COLS} rows={rows} rowKey={(r) => r.id} label="Contacts" sort={sort}
      onSort={(id) => setSort((s) => ({ id, dir: s.id === id && s.dir === 'asc' ? 'desc' : 'asc' }))}
      onRowTap={() => {}} rowLabel={(r) => r.name} rowColor={(r) => r.colour}
      pageSize={pageSize} page={page} onPageChange={setPage} />
  );
}

const meta: Meta<typeof Interactive> = {
  title: 'EQX catalogue/EqxTable',
  component: Interactive,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <div style={{ width: 320 }}>
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Interactive>;

export const Sortable: Story = {};
export const Paged: Story = { args: { pageSize: 2 } };
export const Empty: Story = {
  render: () => <EqxTable columns={COLS} rows={[]} rowKey={(r) => r.id} label="Contacts" empty="Nothing to lock nearby" />,
};
