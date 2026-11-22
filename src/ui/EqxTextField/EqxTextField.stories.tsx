import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { useState } from 'react';
import { eqxTheme } from '../theme.js';
import { EqxTextField } from './EqxTextField.js';

/** EQX catalogue: the one text input. */
const meta: Meta<typeof EqxTextField> = {
  title: 'EQX catalogue/EqxTextField',
  component: EqxTextField,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
  args: { label: 'Callsign', value: 'Vega', disabled: false, onChange: () => {} },
};
export default meta;
type Story = StoryObj<typeof EqxTextField>;

export const Filled: Story = {};
export const Empty: Story = { args: { value: '', placeholder: 'Name your ship' } };
export const Error: Story = { args: { error: 'That name is taken' } };
export const Disabled: Story = { args: { disabled: true } };
/** Type to edit. */
export const Interactive: Story = {
  render: function Render(args) {
    const [v, setV] = useState('');
    return <EqxTextField {...args} value={v} onChange={setV} {...(v.length > 12 ? { error: 'Too long' } : {})} />;
  },
};
