import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { eqxTheme } from '../theme.js';
import { EqxWorldTag } from './EqxWorldTag.js';

/**
 * EQX catalogue: the floating name tag over the selection focus (no box,
 * outlined text, hull bar, pointer). Shown over a dark sky.
 */
const meta: Meta<typeof EqxWorldTag> = {
  title: 'EQX catalogue/EqxWorldTag',
  component: EqxWorldTag,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <div style={{ padding: 24, background: '#0a1020', display: 'inline-block' }}>
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  args: { title: 'Fighter · Vex', owner: 'Hostile', ownerColor: '#ff6b6b', hullPct: 72 },
};
export default meta;
type Story = StoryObj<typeof EqxWorldTag>;

export const Hostile: Story = {};
export const Own: Story = { args: { title: 'Solar Array', owner: 'you', ownerColor: '#6bff9b', hullPct: 100 } };
export const Neutral: Story = { args: { title: 'Freighter · Trader', owner: 'Neutral', ownerColor: '#dfe8f5', hullPct: 30 } };
export const NoHull: Story = { args: { title: 'Asteroid', owner: undefined, hullPct: undefined } };
