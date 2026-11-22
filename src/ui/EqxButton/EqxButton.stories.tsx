import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { eqxTheme } from '../theme.js';
import { EqxButton } from './EqxButton.js';

/** EQX catalogue: the one text button. Tone and size are the only looks. */
const meta: Meta<typeof EqxButton> = {
  title: 'EQX catalogue/EqxButton',
  component: EqxButton,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
  args: { children: 'Launch', tone: 'secondary', size: 'small', disabled: false },
  argTypes: {
    tone: { control: 'inline-radio', options: ['primary', 'secondary', 'danger'] },
    size: { control: 'inline-radio', options: ['small', 'medium', 'large'] },
  },
};
export default meta;
type Story = StoryObj<typeof EqxButton>;

export const Secondary: Story = {};
export const Primary: Story = { args: { tone: 'primary', children: 'Apply' } };
export const PrimaryDisabled: Story = { args: { tone: 'primary', children: 'Apply', disabled: true } };
export const Danger: Story = { args: { tone: 'danger', children: 'Scrap' } };
export const Large: Story = { args: { size: 'large' } };
export const Disabled: Story = { args: { disabled: true } };
