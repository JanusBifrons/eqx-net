import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { useState } from 'react';
import { eqxTheme } from '../theme.js';
import { EqxSwitch } from './EqxSwitch.js';

/** EQX catalogue: the one on/off control. */
const meta: Meta<typeof EqxSwitch> = {
  title: 'EQX catalogue/EqxSwitch',
  component: EqxSwitch,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
  args: { label: 'Full screen', checked: false, disabled: false, onChange: () => {} },
};
export default meta;
type Story = StoryObj<typeof EqxSwitch>;

export const Off: Story = {};
export const On: Story = { args: { checked: true } };
export const Disabled: Story = { args: { disabled: true } };
/** Click to toggle. */
export const Interactive: Story = {
  render: function Render(args) {
    const [on, setOn] = useState(false);
    return <EqxSwitch {...args} checked={on} onChange={setOn} />;
  },
};
