import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import ListIcon from '@mui/icons-material/List';
import MapIcon from '@mui/icons-material/Map';
import { useState } from 'react';
import { eqxTheme } from '../theme.js';
import { EqxSegmented, type EqxSegmentedOption } from './EqxSegmented.js';

/** EQX catalogue: pick one of 2-5 views or values. */
const meta: Meta<typeof EqxSegmented> = {
  title: 'EQX catalogue/EqxSegmented',
  component: EqxSegmented,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof EqxSegmented>;

const TWO: EqxSegmentedOption[] = [
  { id: 'list', label: 'List' },
  { id: 'map', label: 'Map' },
];
const FOUR: EqxSegmentedOption[] = [
  { id: 'all', label: 'All' },
  { id: 'ships', label: 'Ships' },
  { id: 'bases', label: 'Bases' },
  { id: 'rocks', label: 'Rocks' },
];
const ICON_TEXT: EqxSegmentedOption[] = [
  { id: 'list', label: 'List', icon: <ListIcon /> },
  { id: 'map', label: 'Map', icon: <MapIcon /> },
];

const ORDERS: EqxSegmentedOption[] = [
  { id: 'patrol', label: 'Patrol' },
  { id: 'defend', label: 'Defend' },
  { id: 'hunt', label: 'Hunt' },
  { id: 'escort', label: 'Escort' },
  { id: 'retreat', label: 'Retreat' },
];
const ICONS: EqxSegmentedOption[] = [
  { id: 'list', icon: <ListIcon fontSize="small" />, tooltip: 'List' },
  { id: 'map', icon: <MapIcon fontSize="small" />, tooltip: 'Map' },
];

function Picker({ options, disabled = false, hud = false }: { options: EqxSegmentedOption[]; disabled?: boolean; hud?: boolean }) {
  const [v, setV] = useState(options[0]?.id ?? '');
  return <EqxSegmented options={options} value={v} onChange={setV} label="View" disabled={disabled} hud={hud} />;
}

export const TwoText: Story = { render: () => <Picker options={TWO} /> };
export const FourText: Story = { render: () => <Picker options={FOUR} /> };
/** Mock `.seg b.chg`: a pick that differs from the applied order shows amber until applied. */
function Changed() {
  const [v, setV] = useState('patrol');
  return <EqxSegmented options={ORDERS} value={v} appliedValue="defend" onChange={setV} label="Order" />;
}

export const FiveText: Story = { render: () => <Picker options={ORDERS} /> };
export const ChangedNotApplied: Story = { render: () => <Changed /> };
export const Icons: Story = { render: () => <Picker options={ICONS} /> };
export const Disabled: Story = { render: () => <Picker options={TWO} disabled /> };
export const IconAndText: Story = { render: () => <Picker options={ICON_TEXT} /> };
export const Hud: Story = { render: () => <Picker options={ICON_TEXT} hud /> };
