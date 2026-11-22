import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import PublicIcon from '@mui/icons-material/Public';
import SettingsIcon from '@mui/icons-material/Settings';
import { eqxTheme } from '../theme.js';
import { EqxIconButton } from './EqxIconButton.js';

/**
 * EQX catalogue: the one icon button (rail, left strip, fly-outs).
 * Same box for every icon; the tooltip is required and is the aria-label.
 */
const meta: Meta<typeof EqxIconButton> = {
  title: 'EQX catalogue/EqxIconButton',
  component: EqxIconButton,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
  args: { icon: <PublicIcon />, tooltip: 'Galaxy', tone: 'secondary', active: false, disabled: false },
  argTypes: { tone: { control: 'inline-radio', options: ['primary', 'secondary', 'danger'] } },
};
export default meta;
type Story = StoryObj<typeof EqxIconButton>;

export const Default: Story = {};
export const Active: Story = { args: { active: true, tone: 'primary' } };
export const Danger: Story = { args: { tone: 'danger', icon: <SettingsIcon />, tooltip: 'Settings' } };
export const WithBadge: Story = { args: { badge: 3, tooltip: 'Fleet' } };
export const Disabled: Story = { args: { disabled: true } };
/** A long hold before the touch tooltip shows. */
export const SlowHold: Story = { args: { holdMs: 1200 } };
