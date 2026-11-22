import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { eqxTheme } from '../theme.js';
import { EqxBar } from './EqxBar.js';

/**
 * EQX catalogue: a readout bar (Details panel hull / shield / charge rows, and
 * the short inline bar on a building card).
 */
const meta: Meta<typeof EqxBar> = {
  title: 'EQX catalogue/EqxBar',
  component: EqxBar,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <div style={{ width: 300 }}>
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  args: { label: 'Hull', pct: 88, tone: 'hull' },
  argTypes: { tone: { control: 'inline-radio', options: ['hull', 'shield', 'charge'] } },
};
export default meta;
type Story = StoryObj<typeof EqxBar>;

export const Healthy: Story = {};
export const Damaged: Story = { args: { pct: 40 } };
export const Critical: Story = { args: { pct: 12 } };
export const Shield: Story = { args: { label: 'Shield', tone: 'shield', pct: 100 } };
export const Charge: Story = { args: { label: 'Charge', tone: 'charge', pct: 55 } };
export const Short: Story = { args: { label: undefined, short: true, pct: 64 } };
