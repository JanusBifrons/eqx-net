import type { Preview } from '@storybook/react';
import { EqxThemeProvider } from '../src/ui/index.js';

/** Dark space-y backgrounds so the badges/silhouettes read as they do in-game. */
const preview: Preview = {
  // Every story gets the game theme and HUD fonts, as in-game (main.tsx).
  decorators: [
    (Story) => (
      <EqxThemeProvider>
        <Story />
      </EqxThemeProvider>
    ),
  ],
  parameters: {
    backgrounds: {
      default: 'space',
      values: [
        { name: 'space', value: '#05070d' },
        { name: 'panel', value: '#0b0f1a' },
        { name: 'light', value: '#dfe' },
      ],
    },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
};
export default preview;
