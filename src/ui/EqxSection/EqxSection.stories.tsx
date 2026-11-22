import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { eqxTheme } from '../theme.js';
import { EqxListRow } from '../EqxListRow/EqxListRow.js';
import { EqxSection } from './EqxSection.js';

/** EQX catalogue: a section heading in a scrolling panel (contacts, settings, hold). */
const meta: Meta<typeof EqxSection> = {
  title: 'EQX catalogue/EqxSection',
  component: EqxSection,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <div style={{ width: 300 }}>
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  args: { title: 'Nearby' },
};
export default meta;
type Story = StoryObj<typeof EqxSection>;

export const HeadingOnly: Story = {};
export const WithRows: Story = {
  args: {
    children: (
      <>
        <EqxListRow primary="Trade station" side="3.1 km" />
        <EqxListRow primary="Cargo bay" side="4.8 km" />
      </>
    ),
  },
};
