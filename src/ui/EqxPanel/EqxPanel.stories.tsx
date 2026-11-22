import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { useState } from 'react';
import { eqxTheme } from '../theme.js';
import { EqxPanel } from './EqxPanel.js';

/** EQX catalogue: the one right panel (SidePanel evolved). Portrait viewport = bottom sheet. */
const meta: Meta<typeof EqxPanel> = {
  title: 'EQX catalogue/EqxPanel',
  component: EqxPanel,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
  args: { open: true, testId: 'panel', title: 'Fleet orders', closeOnEscape: true, onClose: () => {}, children: 'Body' },
};
export default meta;
type Story = StoryObj<typeof EqxPanel>;

export const Header: Story = {};
export const WithBack: Story = { args: { title: 'Developer', onBack: () => {} } };
export const ApplyClean: Story = { args: { apply: { onApply: () => {}, dirty: false } } };
export const ApplyDirty: Story = { args: { apply: { onApply: () => {}, dirty: true } } };
/** View in a portrait viewport (Storybook viewport toolbar) to see the bottom sheet. */
export const PortraitSheet: Story = { parameters: { viewport: { defaultViewport: 'mobile1' } } };
/** ✕ / Esc close it; Apply clears dirty. */
export const Interactive: Story = {
  render: function Render(args) {
    const [open, setOpen] = useState(true);
    const [dirty, setDirty] = useState(true);
    return (
      <EqxPanel {...args} open={open} onClose={() => setOpen(false)} apply={{ onApply: () => setDirty(false), dirty }} />
    );
  },
};
