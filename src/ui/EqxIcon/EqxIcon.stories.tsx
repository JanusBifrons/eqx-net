import type { Meta, StoryObj } from '@storybook/react';
import { Box, ThemeProvider, Typography } from '@mui/material';
import { eqxTheme } from '../theme.js';
import { HUD } from '../../client/hud/tokens.js';
import { EQX_ICON_NAMES } from '../icons.js';
import { EqxIcon } from './EqxIcon.js';

/**
 * EQX catalogue: the icon registry. One game meaning -> one icon.
 * `AllIcons` shows the full set with names, for owner review.
 */
const meta: Meta<typeof EqxIcon> = {
  title: 'EQX catalogue/EqxIcon',
  component: EqxIcon,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
  args: { name: 'patrol', size: 'medium', stroke: 'regular' },
  argTypes: {
    name: { control: 'select', options: EQX_ICON_NAMES },
    size: { control: 'inline-radio', options: ['small', 'medium', 'large'] },
    stroke: { control: 'inline-radio', options: ['regular', 'light'] },
  },
};
export default meta;
type Story = StoryObj<typeof EqxIcon>;

export const Default: Story = {};
export const Small: Story = { args: { size: 'small' } };
export const Large: Story = { args: { size: 'large' } };
/** The right rail's lighter line (mock: stroke 1.7). */
export const Light: Story = { args: { stroke: 'light' } };

/** Every registered name with its line icon. */
export const AllIcons: Story = {
  render: () => (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${HUD.size.iconButton * 2}px, 1fr))`,
        gap: 1,
        color: HUD.color.sidePanelInk,
      }}
    >
      {EQX_ICON_NAMES.map((name) => (
        <Box key={name} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
          <EqxIcon name={name} size="large" />
          <Typography variant="caption" sx={{ fontFamily: HUD.font.label }}>
            {name}
          </Typography>
        </Box>
      ))}
    </Box>
  ),
};
