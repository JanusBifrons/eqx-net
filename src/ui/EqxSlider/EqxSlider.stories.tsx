import type { Meta, StoryObj } from '@storybook/react';
import { ThemeProvider } from '@mui/material';
import { useState } from 'react';
import { eqxTheme } from '../theme.js';
import { EqxSlider } from './EqxSlider.js';

/** EQX catalogue: the one range control. */
const meta: Meta<typeof EqxSlider> = {
  title: 'EQX catalogue/EqxSlider',
  component: EqxSlider,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Story />
      </ThemeProvider>
    ),
  ],
  args: { label: 'Throttle', min: 0, max: 100, step: 5, value: 40, disabled: false, onChange: () => {} },
};
export default meta;
type Story = StoryObj<typeof EqxSlider>;

export const Plain: Story = {};
export const StepMarks: Story = { args: { min: 0, max: 4, step: 1, value: 2, marks: true } };
export const LabelledMarks: Story = {
  args: {
    marks: [
      { value: 0, label: 'Off' },
      { value: 50, label: 'Half' },
      { value: 100, label: 'Full' },
    ],
  },
};
export const Disabled: Story = { args: { disabled: true } };
/** Drag to change. */
export const Interactive: Story = {
  render: function Render(args) {
    const [v, setV] = useState(args.value);
    return <EqxSlider {...args} value={v} onChange={setV} />;
  },
};
