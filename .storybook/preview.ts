import type { Preview } from '@storybook/react';

/** Dark space-y backgrounds so the badges/silhouettes read as they do in-game. */
const preview: Preview = {
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
