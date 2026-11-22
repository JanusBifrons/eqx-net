import type { Meta, StoryObj } from '@storybook/react';
import { Box, ThemeProvider } from '@mui/material';
import { useState, type ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { eqxTheme } from '../theme.js';
import { EqxSegmented } from '../EqxSegmented/EqxSegmented.js';
import { EQX_PANEL_SIZE, EqxPanel } from './EqxPanel.js';

/** A sideways Pixel 7 (the mock's 915 x 412 frame) and the same phone upright. */
const PHONE_VIEWPORTS = {
  phoneLandscape: { name: 'Phone sideways 915x412', styles: { width: '915px', height: '412px' }, type: 'mobile' },
  phonePortrait: { name: 'Phone upright 412x915', styles: { width: '412px', height: '915px' }, type: 'mobile' },
} as const;

/** Story-only section label (mock `.sec`): small caps, faint. */
function Sec({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Box sx={{ fontFamily: HUD.font.label, fontSize: 9, textTransform: 'uppercase', letterSpacing: '.12em',
      color: HUD.color.inkFaint, mt: '3px' }}>{children}</Box>
  );
}

const ORDERS = [{ id: 'Patrol', label: 'Patrol' }, { id: 'Defend', label: 'Defend' }, { id: 'Hunt', label: 'Hunt' },
  { id: 'Escort', label: 'Escort' }] as const;
const STANCES = [{ id: 'Aggressive', label: 'Aggressive' }, { id: 'Defensive', label: 'Defensive' },
  { id: 'Hold fire', label: 'Hold fire' }] as const;
const SPEEDS = [{ id: 'Stop', label: 'Stop' }, { id: '1/3', label: '⅓' }, { id: '2/3', label: '⅔' },
  { id: 'Full', label: 'Full' }] as const;

/** The mock's fleet panel body; any pick marks the panel dirty. */
function FleetBody({ start, onChange }: { start: string; onChange: () => void }): JSX.Element {
  const [order, setOrder] = useState(start);
  const [stance, setStance] = useState('Defensive');
  const [speed, setSpeed] = useState('Full');
  const pick = (set: (v: string) => void) => (v: string): void => { set(v); onChange(); };
  return (
    <>
      <Sec>Order</Sec>
      <EqxSegmented label="Order" options={ORDERS} value={order} onChange={pick(setOrder)} />
      <Sec>Stance</Sec>
      <EqxSegmented label="Stance" options={STANCES} value={stance} onChange={pick(setStance)} />
      <Sec>Speed</Sec>
      <EqxSegmented label="Speed" options={SPEEDS} value={speed} onChange={pick(setSpeed)} />
    </>
  );
}

/** EQX catalogue: the one right panel (SidePanel evolved), in the mock's 915 x 412 phone frame. */
const meta: Meta<typeof EqxPanel> = {
  title: 'EQX catalogue/EqxPanel',
  component: EqxPanel,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Box sx={{ position: 'fixed', inset: 0, bgcolor: HUD.color.appBg }}>
          <Story />
        </Box>
      </ThemeProvider>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    viewport: { viewports: PHONE_VIEWPORTS, defaultViewport: 'phoneLandscape' },
  },
  args: {
    open: true, testId: 'panel', title: '5 ships selected', closeOnEscape: true, onClose: () => {}, size: EQX_PANEL_SIZE,
  },
  render: function Render(args) {
    const [dirty, setDirty] = useState(args.apply?.dirty ?? false);
    const apply = args.apply === undefined ? undefined : {
      ...args.apply, dirty, onApply: () => setDirty(false), secondary: { label: 'Stop', onClick: () => {} },
    };
    return (
      <EqxPanel {...args} apply={apply}>
        <FleetBody start={dirty ? 'Patrol' : 'Defend'} onChange={() => setDirty(true)} />
      </EqxPanel>
    );
  },
};
export default meta;
type Story = StoryObj<typeof EqxPanel>;

export const Header: Story = {};
/** Nothing changed yet: Apply is cyan and dimmed (off). Pick any option to see it turn amber. */
export const ApplyClean: Story = { args: { apply: { onApply: () => {}, dirty: false } } };
/** A changed, unapplied value: Apply fills amber. */
export const ApplyDirty: Story = { args: { apply: { onApply: () => {}, dirty: true } } };
export const WithBack: Story = { args: { title: '5 ships · details', onBack: () => {} } };
/** Upright phone: the same panel as a bottom sheet. */
export const PortraitSheet: Story = {
  args: { apply: { onApply: () => {}, dirty: false } },
  parameters: { viewport: { viewports: PHONE_VIEWPORTS, defaultViewport: 'phonePortrait' } },
};
