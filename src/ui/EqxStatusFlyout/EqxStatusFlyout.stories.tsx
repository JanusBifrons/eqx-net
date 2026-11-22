import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { useState } from 'react';
import RocketIcon from '@mui/icons-material/RocketLaunch';
import ShieldIcon from '@mui/icons-material/Shield';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import PauseIcon from '@mui/icons-material/PauseCircle';
import SettingsIcon from '@mui/icons-material/Settings';
import CloseIcon from '@mui/icons-material/Close';
import { eqxTheme } from '../theme.js';
import { EqxStatusFlyout, type EqxStatusOption } from './EqxStatusFlyout.js';
import { EqxStrip } from '../EqxStrip/EqxStrip.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';
import { EqxStripIdentity } from '../EqxStripIdentity/EqxStripIdentity.js';

/**
 * EQX catalogue: a strip status whose options fly out to the right.
 * Tap the stance icon to open; tap an option to pick; tap outside or press Esc to close.
 */
const meta: Meta<typeof EqxStatusFlyout> = {
  title: 'EQX catalogue/EqxStatusFlyout',
  component: EqxStatusFlyout,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof EqxStatusFlyout>;

type Stance = 'hold' | 'defend' | 'attack';
const STANCES: readonly EqxStatusOption<Stance>[] = [
  { id: 'hold', icon: <PauseIcon />, tooltip: 'Hold fire' },
  { id: 'defend', icon: <ShieldIcon />, tooltip: 'Defensive', tone: 'primary' },
  { id: 'attack', icon: <GpsFixedIcon />, tooltip: 'Aggressive', tone: 'danger' },
];

function InStrip({ initial }: { initial: Stance }) {
  const [stance, setStance] = useState<Stance>(initial);
  return (
    <EqxStrip aria-label="Selection">
      <EqxStripIdentity icon={<RocketIcon />} tooltip="Fighter" health="ok" />
      <EqxStatusFlyout value={stance} options={STANCES} onChange={setStance} tooltip="Stance" />
      <EqxStrip.Separator />
      <EqxIconButton icon={<SettingsIcon />} tooltip="Full menu" />
      <EqxIconButton icon={<CloseIcon />} tooltip="Deselect" />
    </EqxStrip>
  );
}

/** Defensive stance in a selection strip. */
export const Defensive: Story = { render: () => <InStrip initial="defend" /> };

/** Aggressive stance: the trigger takes the option's danger tone. */
export const Aggressive: Story = { render: () => <InStrip initial="attack" /> };

/** Disabled: the trigger does not open. */
export const Disabled: Story = {
  render: () => (
    <EqxStrip aria-label="Selection">
      <EqxStatusFlyout value="hold" options={STANCES} onChange={() => {}} tooltip="Stance" disabled />
    </EqxStrip>
  ),
};
