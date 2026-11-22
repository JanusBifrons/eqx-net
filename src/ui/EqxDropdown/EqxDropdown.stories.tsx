import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { useState } from 'react';
import { eqxTheme } from '../theme.js';
import { EqxDropdown, type EqxDropdownOption } from './EqxDropdown.js';

/** EQX catalogue: the one pick-from-a-list control. `searchable` swaps Select for Autocomplete. */
const meta: Meta<typeof EqxDropdown> = {
  title: 'EQX catalogue/EqxDropdown',
  component: EqxDropdown,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof EqxDropdown>;

const SHIPS: EqxDropdownOption[] = [
  { id: 'skiff', label: 'Skiff' },
  { id: 'barge', label: 'Barge' },
  { id: 'frigate', label: 'Frigate' },
  { id: 'battleship', label: 'Battleship' },
];

export const Plain: Story = {
  render: function Render() {
    const [v, setV] = useState<string | null>('barge');
    return <EqxDropdown options={SHIPS} value={v} onChange={setV} label="Ship" />;
  },
};
export const PlainPlaceholder: Story = {
  render: function Render() {
    const [v, setV] = useState<string | null>(null);
    return <EqxDropdown options={SHIPS} value={v} onChange={setV} label="Ship" placeholder="Pick a ship" />;
  },
};
export const PlainMultiple: Story = {
  render: function Render() {
    const [v, setV] = useState<string[]>(['skiff']);
    return <EqxDropdown multiple options={SHIPS} value={v} onChange={setV} label="Ships" />;
  },
};
export const Searchable: Story = {
  render: function Render() {
    const [v, setV] = useState<string | null>(null);
    return <EqxDropdown searchable options={SHIPS} value={v} onChange={setV} label="Ship" placeholder="Type to search" />;
  },
};
export const SearchableMultiple: Story = {
  render: function Render() {
    const [v, setV] = useState<string[]>(['barge', 'frigate']);
    return <EqxDropdown searchable multiple options={SHIPS} value={v} onChange={setV} label="Ships" />;
  },
};
export const Disabled: Story = {
  render: () => <EqxDropdown options={SHIPS} value="skiff" onChange={() => {}} label="Ship" disabled />,
};
