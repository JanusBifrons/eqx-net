import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { eqxTheme } from '../theme.js';
import { EqxIcon } from '../EqxIcon/EqxIcon.js';
import { EqxListRow } from './EqxListRow.js';

/** EQX catalogue: a panel list row; with `onOpen` a drill-down row (Trade › Offers). */
const meta: Meta<typeof EqxListRow> = {
  title: 'EQX catalogue/EqxListRow',
  component: EqxListRow,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <div style={{ width: 300 }}>
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  args: { primary: 'Trade station', side: '3.1 km' },
};
export default meta;
type Story = StoryObj<typeof EqxListRow>;

export const Readout: Story = {};
export const DrillDown: Story = { args: { primary: 'Offers', side: '12', onOpen: () => {} } };
export const WithSecondary: Story = { args: { primary: 'Deals', secondary: '2 active', onOpen: () => {} } };
export const WithIcon: Story = { args: { primary: 'History', icon: <EqxIcon name="trade" size="small" />, onOpen: () => {} } };
