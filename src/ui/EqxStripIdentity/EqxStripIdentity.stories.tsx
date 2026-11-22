import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import RocketIcon from '@mui/icons-material/RocketLaunch';
import { eqxTheme } from '../theme.js';
import { EqxStripIdentity } from './EqxStripIdentity.js';

/**
 * EQX catalogue: the round identity icon at the top of the left strip.
 * Ring colour = health; a badge shows the count for groups. Never a portrait.
 */
const meta: Meta<typeof EqxStripIdentity> = {
  title: 'EQX catalogue/EqxStripIdentity',
  component: EqxStripIdentity,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
  args: { icon: <RocketIcon />, tooltip: 'Fighter', health: 'ok' },
  argTypes: { health: { control: 'inline-radio', options: ['ok', 'warn', 'crit'] } },
};
export default meta;
type Story = StoryObj<typeof EqxStripIdentity>;

export const Healthy: Story = {};
export const Damaged: Story = { args: { health: 'warn' } };
export const Critical: Story = { args: { health: 'crit' } };
export const Group: Story = { args: { count: 4, tooltip: 'Fighter wing' } };
