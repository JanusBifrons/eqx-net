import type { Meta, StoryObj } from '@storybook/react';
import { EqxButton } from '../EqxButton/EqxButton.js';
import { EqxThemeProvider } from './EqxThemeProvider.js';

const meta: Meta<typeof EqxThemeProvider> = {
  title: 'EQX catalogue/EqxThemeProvider',
  component: EqxThemeProvider,
};
export default meta;

/** A catalogue entry inside the provider: game fonts and theme colours. */
export const WithButton: StoryObj<typeof EqxThemeProvider> = {
  args: { children: <EqxButton tone="primary">Launch</EqxButton> },
};
