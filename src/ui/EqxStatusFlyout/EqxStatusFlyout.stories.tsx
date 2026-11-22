import type { Meta, StoryObj } from '@storybook/react';
import { Box, ThemeProvider } from '@mui/material';
import { useState } from 'react';
import { EqxIcon } from '../EqxIcon/EqxIcon.js';
import { eqxTheme } from '../theme.js';
import { EqxStatusFlyout, type EqxStatusOption } from './EqxStatusFlyout.js';
import { EqxStrip } from '../EqxStrip/EqxStrip.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';
import { EqxStripIdentity } from '../EqxStripIdentity/EqxStripIdentity.js';

/**
 * EQX catalogue: a strip status whose options fly out to the right (mock .flyo).
 * Tap the stance icon to open; tap an option to pick; tap outside or press Esc to close.
 * Shown inside a 915 x 412 sideways-phone frame, strip docked left and vertically centred.
 */
const meta: Meta<typeof EqxStatusFlyout> = {
  title: 'EQX catalogue/EqxStatusFlyout',
  component: EqxStatusFlyout,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Box sx={{ width: 915, height: 412, bgcolor: '#05070e', display: 'flex', alignItems: 'center' }}>
          <Story />
        </Box>
      </ThemeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof EqxStatusFlyout>;

type Stance = 'aggressive' | 'defensive' | 'hold';
const STANCES: readonly EqxStatusOption<Stance>[] = [
  { id: 'aggressive', icon: <EqxIcon name="aggressive" />, tooltip: 'Aggressive', tone: 'danger' },
  { id: 'defensive', icon: <EqxIcon name="defensive" />, tooltip: 'Defensive' },
  { id: 'hold', icon: <EqxIcon name="holdFire" />, tooltip: 'Hold fire' },
];

function InStrip({ initial }: { initial: Stance }) {
  const [stance, setStance] = useState<Stance>(initial);
  return (
    <EqxStrip aria-label="Selection">
      <EqxStripIdentity icon={<EqxIcon name="fleet" />} tooltip="5 ships selected" health="ok" count={5} />
      <EqxStatusFlyout value={stance} options={STANCES} onChange={setStance} tooltip="Stance" data-testid="stance" />
      <EqxStrip.Separator />
      <EqxIconButton variant="strip" tone="danger" icon={<EqxIcon name="stop" />} tooltip="Stop" />
      <EqxIconButton variant="strip" icon={<EqxIcon name="cog" />} tooltip="All orders and details" />
      <EqxIconButton variant="strip" icon={<EqxIcon name="close" />} tooltip="Deselect" />
    </EqxStrip>
  );
}

/** Opens the fly-out once the story mounts (plain DOM click, no extra addon). */
const openOnMount: Story['play'] = async ({ canvasElement }) => {
  canvasElement.querySelector<HTMLElement>('[data-testid="stance"]')?.click();
};

/** Defensive stance in a five-ship selection strip, fly-out closed. */
export const Defensive: Story = { render: () => <InStrip initial="defensive" /> };

/** Aggressive stance: the status icon turns red. */
export const Aggressive: Story = { render: () => <InStrip initial="aggressive" /> };

/** Fly-out open: cyan box to the right, current option cyan, trigger ringed. */
export const Open: Story = { render: () => <InStrip initial="defensive" />, play: openOnMount };

/** Disabled: the trigger does not open. */
export const Disabled: Story = {
  render: () => (
    <EqxStrip aria-label="Selection">
      <EqxStatusFlyout value="hold" options={STANCES} onChange={() => {}} tooltip="Stance" disabled />
    </EqxStrip>
  ),
};
