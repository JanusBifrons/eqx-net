import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import RocketIcon from '@mui/icons-material/RocketLaunch';
import StopIcon from '@mui/icons-material/Stop';
import SettingsIcon from '@mui/icons-material/Settings';
import CloseIcon from '@mui/icons-material/Close';
import CheckIcon from '@mui/icons-material/Check';
import RotateIcon from '@mui/icons-material/RotateRight';
import FactoryIcon from '@mui/icons-material/Factory';
import { eqxTheme } from '../theme.js';
import { EqxStrip } from './EqxStrip.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';
import { EqxStripIdentity } from '../EqxStripIdentity/EqxStripIdentity.js';

/**
 * EQX catalogue: the left strip. One icon column, no text except count badges,
 * tooltips on hover / tap-and-hold. Toggle `open` to see the slide.
 */
const meta: Meta<typeof EqxStrip> = {
  title: 'EQX catalogue/EqxStrip',
  component: EqxStrip,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof EqxStrip>;

const selection = [
  <EqxStripIdentity key="id" icon={<RocketIcon />} tooltip="Fighter" health="ok" />,
  <EqxIconButton key="stop" icon={<StopIcon />} tooltip="Stop" tone="danger" />,
  <EqxStrip.Separator key="sep" />,
  <EqxIconButton key="menu" icon={<SettingsIcon />} tooltip="Full menu" />,
  <EqxIconButton key="x" icon={<CloseIcon />} tooltip="Deselect" />,
];

/** Selection mode: identity, a quick action, separator, menu, deselect. */
export const Selection: Story = { args: { 'aria-label': 'Selection', children: selection } };

/** A damaged group of four. */
export const Group: Story = {
  args: {
    children: [
      <EqxStripIdentity key="id" icon={<RocketIcon />} tooltip="Fighter wing" health="crit" count={4} />,
      <EqxIconButton key="stop" icon={<StopIcon />} tooltip="Stop" tone="danger" />,
      <EqxStrip.Separator key="sep" />,
      <EqxIconButton key="x" icon={<CloseIcon />} tooltip="Deselect" />,
    ],
  },
};

/** Doing mode: placing a building. */
export const Placing: Story = {
  args: {
    children: [
      <EqxIconButton key="b" icon={<FactoryIcon />} tooltip="Factory" active tone="primary" />,
      <EqxIconButton key="ok" icon={<CheckIcon />} tooltip="Place" tone="primary" />,
      <EqxIconButton key="r" icon={<RotateIcon />} tooltip="Rotate" />,
      <EqxIconButton key="x" icon={<CloseIcon />} tooltip="Stop placing" tone="danger" />,
    ],
  },
};

/** Slides in (true) / fully out of view (false). */
export const Sliding: Story = { args: { open: true, children: selection } };
export const Closed: Story = { args: { open: false, children: selection } };

/** One row of the same buttons (how EqxStatusFlyout shows its options). */
export const Horizontal: Story = {
  args: {
    orientation: 'horizontal',
    'aria-label': 'Stance',
    children: [
      <EqxIconButton key="stop" icon={<StopIcon />} tooltip="Stop" tone="danger" />,
      <EqxIconButton key="r" icon={<RotateIcon />} tooltip="Rotate" active />,
      <EqxIconButton key="ok" icon={<CheckIcon />} tooltip="Place" tone="primary" />,
    ],
  },
};
