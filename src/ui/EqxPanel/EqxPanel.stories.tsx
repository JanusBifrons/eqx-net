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
  { id: 'Escort', label: 'Escort' }, { id: 'Retreat', label: 'Retreat' }] as const;
const STANCES = [{ id: 'Aggressive', label: 'Aggressive' }, { id: 'Defensive', label: 'Defensive' },
  { id: 'Hold fire', label: 'Hold fire' }] as const;
const SPEEDS = [{ id: 'Stop', label: 'Stop' }, { id: '1/3', label: '⅓' }, { id: '2/3', label: '⅔' },
  { id: 'Full', label: 'Full' }] as const;

interface FleetOrders { order: string; stance: string; speed: string }
/** What the fleet is doing now (applied). */
const APPLIED: FleetOrders = { order: 'Defend', stance: 'Defensive', speed: 'Full' };

/** The mock's fleet panel body: a pick that differs from the applied value shows amber
 *  (EqxSegmented `appliedValue`). No Ships rows yet: the catalogue has no bar entry. */
function FleetBody({ value, applied, onChange }: {
  value: FleetOrders; applied: FleetOrders; onChange: (next: FleetOrders) => void;
}): JSX.Element {
  return (
    <>
      <Sec>Order</Sec>
      <EqxSegmented label="Order" options={ORDERS} value={value.order} appliedValue={applied.order}
        onChange={(order) => onChange({ ...value, order })} />
      <Sec>Stance</Sec>
      <EqxSegmented label="Stance" options={STANCES} value={value.stance} appliedValue={applied.stance}
        onChange={(stance) => onChange({ ...value, stance })} />
      <Sec>Speed</Sec>
      <EqxSegmented label="Speed" options={SPEEDS} value={value.speed} appliedValue={applied.speed}
        onChange={(speed) => onChange({ ...value, speed })} />
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
    const [applied, setApplied] = useState(APPLIED);
    const [value, setValue] = useState(args.apply?.dirty === true ? { ...APPLIED, order: 'Patrol' } : APPLIED);
    const dirty = value.order !== applied.order || value.stance !== applied.stance || value.speed !== applied.speed;
    const apply = args.apply === undefined ? undefined : {
      ...args.apply, dirty, onApply: () => setApplied(value), secondary: { label: 'Stop', onClick: () => {} },
    };
    return (
      <EqxPanel {...args} apply={apply}>
        <FleetBody value={value} applied={applied} onChange={setValue} />
      </EqxPanel>
    );
  },
};
export default meta;
type Story = StoryObj<typeof EqxPanel>;

export const Header: Story = {};
/** Nothing changed yet: Apply is cyan and dimmed (off). Pick any option: it shows amber, Apply turns on. */
export const ApplyClean: Story = { args: { apply: { onApply: () => {}, dirty: false } } };
/** A changed, unapplied order (Patrol over the applied Defend): the segment is amber, Apply is plain cyan. */
export const ApplyDirty: Story = { args: { apply: { onApply: () => {}, dirty: true } } };
export const WithBack: Story = { args: { title: '5 ships · details', onBack: () => {} } };
/** Upright phone: the same panel as a bottom sheet. */
export const PortraitSheet: Story = {
  args: { apply: { onApply: () => {}, dirty: false } },
  parameters: { viewport: { viewports: PHONE_VIEWPORTS, defaultViewport: 'phonePortrait' } },
};
