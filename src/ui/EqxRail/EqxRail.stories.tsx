import type { Meta, StoryObj } from '@storybook/react';
import { Box, ThemeProvider } from '@mui/material';
import PublicIcon from '@mui/icons-material/Public';
import WorkIcon from '@mui/icons-material/Work';
import StorefrontIcon from '@mui/icons-material/Storefront';
import FlagIcon from '@mui/icons-material/Flag';
import RadarIcon from '@mui/icons-material/Radar';
import InventoryIcon from '@mui/icons-material/Inventory2';
import { eqxTheme } from '../theme.js';
import { HUD } from '../../client/hud/tokens.js';
import { EqxRail, type EqxRailItem } from './EqxRail.js';

/**
 * EQX catalogue: the slim right rail (plan A3). Icons only, labels in tooltips,
 * at most 8 items plus the cog pinned at the bottom. Fills its parent; here a
 * phone-height (360 px) box stands in for the right-rail Slot.
 */
const FLY: EqxRailItem[] = [
  { id: 'contacts', icon: <RadarIcon />, tooltip: 'Contacts' },
  { id: 'hold', icon: <InventoryIcon />, tooltip: 'Hold', badge: 2 },
  { id: 'galaxy', icon: <PublicIcon />, tooltip: 'Galaxy' },
  { id: 'jobs', icon: <WorkIcon />, tooltip: 'Jobs' },
  { id: 'trade', icon: <StorefrontIcon />, tooltip: 'Trade' },
  { id: 'faction', icon: <FlagIcon />, tooltip: 'Faction' },
];
const EIGHT: EqxRailItem[] = [
  ...FLY,
  { id: 'extra1', icon: <PublicIcon />, tooltip: 'Extra 1' },
  { id: 'extra2', icon: <WorkIcon />, tooltip: 'Extra 2' },
];

const meta: Meta<typeof EqxRail> = {
  title: 'EQX catalogue/EqxRail',
  component: EqxRail,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Box sx={{ height: 360, display: 'inline-block', bgcolor: HUD.color.appBg }}>
          <Story />
        </Box>
      </ThemeProvider>
    ),
  ],
  args: { items: FLY, cog: true, onPick: () => {} },
};
export default meta;
type Story = StoryObj<typeof EqxRail>;

/** Fly mode, desktop width, nothing open. */
export const Desktop: Story = { args: { compact: false } };
/** Phone width (48 px). */
export const Phone: Story = { args: { compact: true } };
/** Galaxy open: one item active. */
export const ActiveItem: Story = { args: { activeId: 'galaxy' } };
/** Settings open: the cog active. */
export const ActiveCog: Story = { args: { activeId: 'cog' } };
/** The cap: 8 items plus the cog. */
export const Full: Story = { args: { items: EIGHT, compact: true } };
/** No cog. */
export const NoCog: Story = { args: { cog: false } };
