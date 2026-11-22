import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { eqxTheme } from '../theme.js';
import { EqxButton } from '../EqxButton/EqxButton.js';
import { EqxTooltip } from './EqxTooltip.js';

/** EQX catalogue: hover on desktop, press-and-hold (`holdMs`) on touch. */
const meta: Meta<typeof EqxTooltip> = {
  title: 'EQX catalogue/EqxTooltip',
  component: EqxTooltip,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
  args: { title: 'Open the galaxy map' },
  render: (args) => (
    <EqxTooltip {...args}>
      <span>
        <EqxButton>Hover or hold me</EqxButton>
      </span>
    </EqxTooltip>
  ),
};
export default meta;
type Story = StoryObj<typeof EqxTooltip>;

export const Default: Story = {};
export const QuickHold: Story = { args: { holdMs: 200 } };
export const SlowHold: Story = { args: { holdMs: 1200 } };
