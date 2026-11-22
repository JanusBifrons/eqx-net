import type { Meta, StoryObj } from '@storybook/react';
import { Box, ThemeProvider } from '@mui/material';
import RocketIcon from '@mui/icons-material/RocketLaunchOutlined';
import DefendIcon from '@mui/icons-material/ShieldOutlined';
import AggressiveIcon from '@mui/icons-material/GpsFixed';
import StopIcon from '@mui/icons-material/StopCircleOutlined';
import SettingsIcon from '@mui/icons-material/SettingsOutlined';
import CloseIcon from '@mui/icons-material/Close';
import CheckIcon from '@mui/icons-material/Check';
import RotateIcon from '@mui/icons-material/RotateRight';
import MirrorIcon from '@mui/icons-material/Flip';
import FactoryIcon from '@mui/icons-material/FactoryOutlined';
import { eqxTheme } from '../theme.js';
import { EqxStrip } from './EqxStrip.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';
import { EqxStripIdentity } from '../EqxStripIdentity/EqxStripIdentity.js';

/**
 * EQX catalogue: the left strip (mock .lbar). One icon column docked to the
 * left edge, no text except count badges, tooltips on hover / tap-and-hold.
 * Shown inside a 915 x 412 sideways-phone frame, vertically centred like the mock.
 */
const meta: Meta<typeof EqxStrip> = {
  title: 'EQX catalogue/EqxStrip',
  component: EqxStrip,
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
type Story = StoryObj<typeof EqxStrip>;

const fleet5 = [
  <EqxStripIdentity key="id" icon={<RocketIcon />} tooltip="5 ships selected" health="ok" count={5} />,
  <EqxIconButton key="order" variant="strip" status="calm" icon={<DefendIcon />} tooltip="Order: Defend" />,
  <EqxIconButton key="stance" variant="strip" status="alert" icon={<AggressiveIcon />} tooltip="Stance: Aggressive" />,
  <EqxStrip.Separator key="sep" />,
  <EqxIconButton key="stop" variant="strip" tone="danger" icon={<StopIcon />} tooltip="Stop" />,
  <EqxIconButton key="menu" variant="strip" icon={<SettingsIcon />} tooltip="All orders and details" />,
  <EqxIconButton key="x" variant="strip" icon={<CloseIcon />} tooltip="Deselect" />,
];

/** Five ships selected: identity + count, order and stance status, separator, actions. */
export const Selection: Story = { args: { 'aria-label': 'Selection', children: fleet5 } };

/** One damaged ship: gold ring, no count. */
export const ShipDamaged: Story = {
  args: {
    'aria-label': 'Selection',
    children: [
      <EqxStripIdentity key="id" icon={<RocketIcon />} tooltip="Fighter, hull 64%" health="warn" />,
      <EqxIconButton key="order" variant="strip" status="calm" icon={<DefendIcon />} tooltip="Order: Defend" />,
      <EqxStrip.Separator key="sep" />,
      <EqxIconButton key="menu" variant="strip" icon={<SettingsIcon />} tooltip="Details" />,
      <EqxIconButton key="x" variant="strip" icon={<CloseIcon />} tooltip="Deselect" />,
    ],
  },
};

/** A critically damaged ship: red ring. */
export const ShipCritical: Story = {
  args: {
    'aria-label': 'Selection',
    children: [
      <EqxStripIdentity key="id" icon={<RocketIcon />} tooltip="Fighter, hull 18%" health="crit" />,
      <EqxStrip.Separator key="sep" />,
      <EqxIconButton key="x" variant="strip" icon={<CloseIcon />} tooltip="Deselect" />,
    ],
  },
};

/** Placing a building: place (ok), rotate, mirror, separator, stop placing (no). */
export const Placing: Story = {
  args: {
    'aria-label': 'Placing',
    children: [
      <EqxStripIdentity key="id" icon={<FactoryIcon />} tooltip="Placing: Refinery" health="ok" />,
      <EqxIconButton key="ok" variant="strip" tone="primary" icon={<CheckIcon />} tooltip="Place" />,
      <EqxIconButton key="r" variant="strip" icon={<RotateIcon />} tooltip="Rotate (R)" />,
      <EqxIconButton key="m" variant="strip" icon={<MirrorIcon />} tooltip="Mirror (F)" />,
      <EqxStrip.Separator key="sep" />,
      <EqxIconButton key="x" variant="strip" tone="danger" icon={<CloseIcon />} tooltip="Stop placing" />,
    ],
  },
};

/** Slides in (true) / fully out of view (false). */
export const Sliding: Story = { args: { open: true, children: fleet5 } };
export const Closed: Story = { args: { open: false, children: fleet5 } };
