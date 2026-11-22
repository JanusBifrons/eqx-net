import type { Decorator, Meta, StoryObj } from '@storybook/react';
import { Box, ThemeProvider } from '@mui/material';
import type { ReactNode } from 'react';
import { eqxTheme } from '../theme.js';
import { HUD } from '../../client/hud/tokens.js';
import { EqxRail, type EqxRailItem } from './EqxRail.js';

/**
 * EQX catalogue: the slim right rail (plan A3, mock .rail). Mode tools above the divider,
 * the always-there items below, the cog pinned at the bottom. Labels only in tooltips.
 * The rail fills its parent; here it sits on the right edge of a dark screen-sized frame
 * (phone 915x412, desktop 1600x900) so it reads like the mock.
 */
function line(children: ReactNode): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

// The mock's line icons (mockups.html `I`).
const ICON = {
  contacts: line(
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12l6-6" />
    </>,
  ),
  hold: line(
    <>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </>,
  ),
  galaxy: line(
    <>
      <circle cx="12" cy="12" r="2.5" />
      <ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-25 12 12)" />
    </>,
  ),
  jobs: line(
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 3h6v3H9zM8.5 12h7M8.5 16h5" />
    </>,
  ),
  trade: line(<path d="M4 8h15l-3-3M20 16H5l3 3" />),
  faction: line(<path d="M5 21V4M5 4h12l-2.5 4L17 12H5" />),
  fleet: line(<path d="M6 4l4 7H2zM18 4l4 7h-8zM12 13l4 7H8z" />),
};

const TOOLS: EqxRailItem[] = [
  { id: 'contacts', icon: ICON.contacts, tooltip: 'Contacts' },
  { id: 'hold', icon: ICON.hold, tooltip: 'Hold' },
];
const ITEMS: EqxRailItem[] = [
  { id: 'galaxy', icon: ICON.galaxy, tooltip: 'Galaxy' },
  { id: 'jobs', icon: ICON.jobs, tooltip: 'Jobs' },
  { id: 'trade', icon: ICON.trade, tooltip: 'Trade' },
  { id: 'faction', icon: ICON.faction, tooltip: 'Faction' },
];
const SIX_MORE: EqxRailItem[] = [
  { id: 'fleet', icon: ICON.fleet, tooltip: 'Fleet' },
  { id: 'extra', icon: ICON.contacts, tooltip: 'Extra' },
];

function screen(w: number, h: number): Decorator {
  const Frame: Decorator = (Story) => (
    <ThemeProvider theme={eqxTheme}>
      <Box sx={{ width: w, height: h, position: 'relative', bgcolor: HUD.color.appBg, overflow: 'hidden' }}>
        <Box sx={{ position: 'absolute', top: 0, right: 0, bottom: 0, display: 'flex' }}>
          <Story />
        </Box>
      </Box>
    </ThemeProvider>
  );
  return Frame;
}
const PHONE = screen(915, 412);
const DESKTOP = screen(1600, 900);

const meta: Meta<typeof EqxRail> = {
  title: 'EQX catalogue/EqxRail',
  component: EqxRail,
  parameters: { layout: 'fullscreen' },
  args: { tools: TOOLS, items: ITEMS, cog: true, onPick: () => {} },
};
export default meta;
type Story = StoryObj<typeof EqxRail>;

/** Phone (sideways Pixel 7, 48 px rail), fly mode, nothing open. */
export const Phone: Story = { args: { compact: true }, decorators: [PHONE] };
/** Desktop (56 px rail), fly mode, nothing open. */
export const Desktop: Story = { args: { compact: false }, decorators: [DESKTOP] };
/** Galaxy open: one item active (cyan well + inset bar). */
export const ActiveItem: Story = { args: { compact: true, activeId: 'galaxy' }, decorators: [PHONE] };
/** A mode tool open. */
export const ActiveTool: Story = { args: { compact: true, activeId: 'contacts' }, decorators: [PHONE] };
/** Settings open: the cog active. */
export const ActiveCog: Story = { args: { compact: true, activeId: 'cog' }, decorators: [PHONE] };
/** A count badge on the hold. */
export const Badge: Story = {
  args: { compact: true, tools: [TOOLS[0]!, { ...TOOLS[1]!, badge: 2 }] },
  decorators: [PHONE],
};
/** No mode tools: no divider. */
export const NoTools: Story = { args: { compact: true, tools: [] }, decorators: [PHONE] };
/** The cap: 8 items plus the cog. */
export const Full: Story = { args: { compact: true, tools: [...TOOLS, ...SIX_MORE] }, decorators: [PHONE] };
/** No cog. */
export const NoCog: Story = { args: { compact: true, cog: false }, decorators: [PHONE] };
