import type { Meta, StoryObj } from '@storybook/react';
import { Box, GlobalStyles, ThemeProvider } from '@mui/material';
import { useState } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { Z } from '../../client/layout/zIndex.js';
import { eqxTheme } from '../theme.js';
import { EqxIcon } from '../EqxIcon/EqxIcon.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';
import type { EqxPanelProps } from '../EqxPanel/EqxPanel.js';
import { EqxRail, type EqxRailItem } from '../EqxRail/EqxRail.js';
import { EqxStatusFlyout, type EqxStatusOption } from '../EqxStatusFlyout/EqxStatusFlyout.js';
import { EqxStrip } from '../EqxStrip/EqxStrip.js';
import { EqxStripIdentity } from '../EqxStripIdentity/EqxStripIdentity.js';
import panelStories, { ApplyDirty } from '../EqxPanel/EqxPanel.stories.js';
import railStories from '../EqxRail/EqxRail.stories.js';

/**
 * EQX catalogue: the whole layout (mock-ups "anatomy" and "fleet panel apply" frames).
 * Rail on the right edge; the fleet panel docked left of the rail (EqxPanel's ApplyDirty
 * story, reused); the selection strip on the left edge at 57% height (mock .lbar) with its
 * order and stance fly-outs. Never both sides (mock): the strip slides away while the panel
 * is open; the panel's ✕ brings it back, the strip's ⚙ opens the panel.
 * Fills whatever screen opens it (no forced viewport).
 */

const PANEL_TEST_ID = 'layout-panel';

/** Command mode: the rail's mode tool is Fleet; the always-there items and cog from EqxRail's stories. */
const RAIL_TOOLS: EqxRailItem[] = [{ id: 'fleet', icon: <EqxIcon name="fleet" />, tooltip: 'Fleet' }];
const RAIL_ITEMS: readonly EqxRailItem[] = railStories.args?.items ?? [];

type Order = 'patrol' | 'defend' | 'hunt' | 'escort' | 'retreat';
const ORDERS: readonly EqxStatusOption<Order>[] = [
  { id: 'patrol', icon: <EqxIcon name="patrol" />, tooltip: 'Patrol' },
  { id: 'defend', icon: <EqxIcon name="defend" />, tooltip: 'Defend' },
  { id: 'hunt', icon: <EqxIcon name="hunt" />, tooltip: 'Hunt' },
  { id: 'escort', icon: <EqxIcon name="escort" />, tooltip: 'Escort' },
  { id: 'retreat', icon: <EqxIcon name="retreat" />, tooltip: 'Retreat' },
];
type Stance = 'aggressive' | 'defensive' | 'hold';
const STANCES: readonly EqxStatusOption<Stance>[] = [
  { id: 'aggressive', icon: <EqxIcon name="aggressive" />, tooltip: 'Aggressive', tone: 'danger' },
  { id: 'defensive', icon: <EqxIcon name="defensive" />, tooltip: 'Defensive' },
  { id: 'hold', icon: <EqxIcon name="holdFire" />, tooltip: 'Hold fire' },
];

/** The game behind the HUD (mock .scr background + .stars); story-only paint. */
const WORLD_SX = {
  position: 'fixed',
  inset: 0,
  overflow: 'hidden',
  bgcolor: HUD.color.appBg,
  backgroundImage: [
    'radial-gradient(1px 1px at 12% 22%,#fff8,transparent)',
    'radial-gradient(1px 1px at 52% 12%,#fff6,transparent)',
    'radial-gradient(1px 1px at 80% 33%,#fff7,transparent)',
    'radial-gradient(1px 1px at 33% 80%,#fff5,transparent)',
    'radial-gradient(1px 1px at 66% 88%,#fff6,transparent)',
    'radial-gradient(1px 1px at 9% 64%,#fff5,transparent)',
    'radial-gradient(ellipse at 30% 40%,#14203d 0,transparent 55%)',
    'radial-gradient(ellipse at 75% 70%,#1d1533 0,transparent 50%)',
  ].join(','),
} as const;

/** EqxPanel's own story render (fleet body, ORDER / STANCE / SPEED, Stop + Apply). */
function FleetPanel(props: EqxPanelProps): JSX.Element {
  const render = panelStories.render;
  if (render === undefined) throw new Error('EqxPanel stories lost their render');
  return <>{render(props, {} as never)}</>;
}

interface LayoutProps {
  /** Phone (48 px rail) or desktop (56 px rail). */
  compact: boolean;
  /** Fleet panel open at first. */
  panelOpen: boolean;
}

function Layout({ compact, panelOpen: initialOpen }: LayoutProps): JSX.Element {
  const [panelOpen, setPanelOpen] = useState(initialOpen);
  const [order, setOrder] = useState<Order>('defend');
  const [stance, setStance] = useState<Stance>('defensive');
  const railW = compact ? HUD.size.railPhone : HUD.size.railDesktop;
  const panelArgs = {
    ...panelStories.args,
    ...ApplyDirty.args,
    open: panelOpen,
    onClose: () => setPanelOpen(false),
    testId: PANEL_TEST_ID,
  } as EqxPanelProps;
  return (
    <ThemeProvider theme={eqxTheme}>
      {/* As in the game (RightPanelHost): the rail sets --rail-w; EqxPanel docks left of it. */}
      <GlobalStyles styles={{ ':root': { '--rail-w': `${railW}px` } }} />
      <Box sx={WORLD_SX} data-testid="layout">
        <Box sx={{ position: 'absolute', left: 0, top: '57%', transform: 'translateY(-50%)' }}>
          <EqxStrip aria-label="Selection" open={!panelOpen} data-testid="layout-strip">
            <EqxStripIdentity icon={<EqxIcon name="fleet" />} tooltip="5 ships selected" health="ok" count={5} />
            <EqxStatusFlyout value={order} options={ORDERS} onChange={setOrder} tooltip="Order" data-testid="order" />
            <EqxStatusFlyout value={stance} options={STANCES} onChange={setStance} tooltip="Stance" data-testid="stance" />
            <EqxStrip.Separator />
            <EqxIconButton variant="strip" tone="danger" icon={<EqxIcon name="stop" />} tooltip="Stop" />
            <EqxIconButton
              variant="strip"
              icon={<EqxIcon name="cog" />}
              tooltip="All orders and details"
              onClick={() => setPanelOpen(true)}
              data-testid="layout-open-panel"
            />
            <EqxIconButton variant="strip" icon={<EqxIcon name="close" />} tooltip="Deselect" />
          </EqxStrip>
        </Box>
        <FleetPanel {...panelArgs} />
      </Box>
      {/* The rail stacks ABOVE the panel (Z.railStrip over Z.panel, mock .rail z 5 over
          .panel z 4), so the panel slides in and out beneath it. Outside the world box:
          a fixed box is its own stacking context and would trap the rail under the panel. */}
      <Box sx={{ position: 'fixed', top: 0, right: 0, bottom: 0, display: 'flex', zIndex: Z.railStrip }}>
        <EqxRail tools={RAIL_TOOLS} items={RAIL_ITEMS} cog onPick={() => {}} compact={compact} data-testid="layout-rail" />
      </Box>
    </ThemeProvider>
  );
}

const meta: Meta<typeof Layout> = {
  title: 'EQX catalogue/Full layout',
  component: Layout,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof Layout>;

/** Phone: fleet panel open (Patrol picked over the applied Defend: amber, Apply on); strip slid away. */
export const PhoneFleetPanel: Story = { args: { compact: true, panelOpen: true } };
/** Phone: rail and the selection strip only; ⚙ on the strip opens the panel. */
export const PhonePanelClosed: Story = { args: { compact: true, panelOpen: false } };
/** Desktop (56 px rail), fleet panel open. */
export const Desktop: Story = { args: { compact: false, panelOpen: true } };
