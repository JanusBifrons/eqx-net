import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { eqxTheme } from '../theme.js';
import { EqxPrompt, EqxPromptStack } from './EqxPrompt.js';

/** EQX catalogue: the top-centre answer-me prompt and toast. */
const meta: Meta<typeof EqxPrompt> = {
  title: 'EQX catalogue/EqxPrompt',
  component: EqxPrompt,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <div style={{ width: 420, display: 'flex', justifyContent: 'center' }}>
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  args: { message: 'Doors closing.', tone: 'warn' },
};
export default meta;
type Story = StoryObj<typeof EqxPrompt>;

const noop = (): void => {};

export const Readout: Story = {};
export const Toll: Story = {
  args: {
    message: 'Kestrel charges 25¢ to ride this teleporter.',
    tone: 'gold',
    actions: [
      { label: 'Pay', onPick: noop, tone: 'primary' },
      { label: "Don't pay", onPick: noop },
      { label: 'Always pay', onPick: noop },
      { label: 'Never pay', onPick: noop },
    ],
  },
};
export const PairRequest: Story = {
  args: { message: 'Kestrel asks to pair Gate 2.', tone: 'info', actions: [{ label: 'Accept', onPick: noop, tone: 'primary' }, { label: 'Decline', onPick: noop }] },
};
export const WarpChip: Story = {
  args: { message: 'Warping to Belt A', tone: 'info', inline: true, actions: [{ label: 'Cancel', onPick: noop, tone: 'danger' }] },
};
export const HostileWarp: Story = { args: { message: '⚠ 8 × Legionnaires warping in — 42s', tone: 'danger' } };
export const AllClear: Story = { args: { message: '✓ Nothing incoming', tone: 'good', dim: true } };
export const DangerToast: Story = { args: { message: 'Your trade hauler is under fire!', tone: 'danger', onTap: noop } };
export const Stack: Story = {
  render: () => (
    <EqxPromptStack>
      <EqxPrompt message="Deal agreed" tone="good" onTap={noop} />
      <EqxPrompt message="Sold 20 Salvage for 95 cr" tone="plain" onTap={noop} />
      <EqxPrompt message="An elite was sighted in Vega" tone="gold" />
    </EqxPromptStack>
  ),
};
