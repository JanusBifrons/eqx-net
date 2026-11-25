import type { Meta, StoryObj } from '@storybook/react';
import { Box, ThemeProvider } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';
import { eqxTheme } from '../theme.js';
import { EqxWindow } from './EqxWindow.js';
import { WINDOW_FOOT_SX, WINDOW_HEAD_SX, WINDOW_ROOT_SX, WINDOW_TITLE_SX, WINDOW_X_SX } from './windowParts.js';

/** A sideways Pixel 7 and a desktop screen. */
const VIEWPORTS = {
  phoneLandscape: { name: 'Phone sideways 915x412', styles: { width: '915px', height: '412px' }, type: 'mobile' },
  desktop: { name: 'Desktop 1440x900', styles: { width: '1440px', height: '900px' }, type: 'desktop' },
} as const;

/** Story-only body rows, so the scrolling body has something to scroll. */
function Rows(): JSX.Element {
  return (
    <Box sx={{ p: `${HUD.window.padX}px`, fontFamily: HUD.font.label, fontSize: HUD.window.font, color: HUD.color.ink }}>
      {Array.from({ length: 24 }, (_, i) => <Box key={i} sx={{ py: '4px' }}>Alloy · stack {i + 1}</Box>)}
    </Box>
  );
}

/** EQX catalogue: the one full-screen Window (GameWindow evolved; the loot window's shell). */
const meta: Meta<typeof EqxWindow> = {
  title: 'EQX catalogue/EqxWindow',
  component: EqxWindow,
  decorators: [
    (Story) => (
      <ThemeProvider theme={eqxTheme}>
        <Box sx={{ position: 'fixed', inset: 0, bgcolor: HUD.color.appBg }}>
          <Story />
        </Box>
      </ThemeProvider>
    ),
  ],
  parameters: { layout: 'fullscreen', viewport: { viewports: VIEWPORTS } },
  args: { open: true, testId: 'window', closeTestId: 'window-x', onClose: () => {} },
};
export default meta;
type Story = StoryObj<typeof EqxWindow>;

/** The window draws its own header (title + ✕) over a scrolling body. */
export const WithTitle: Story = { args: { title: 'Wreck · Hauler', children: <Rows /> } };

/** No title: the content draws its own header and footer from the window parts (as CargoPanel does). */
export const OwnHeader: Story = {
  args: {
    children: (
      <Box sx={WINDOW_ROOT_SX}>
        <Box sx={WINDOW_HEAD_SX}>
          <Box sx={WINDOW_TITLE_SX}>Storage · yours</Box>
          <Box component="button" type="button" sx={WINDOW_X_SX} aria-label="Close">✕</Box>
        </Box>
        <Box sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}><Rows /></Box>
        <Box sx={WINDOW_FOOT_SX}>Drag or tap an item to move it</Box>
      </Box>
    ),
  },
};

/** A sideways phone frame (on a touch phone the window fills the screen less the margin). */
export const PhoneSideways: Story = {
  args: { title: 'Wreck · Hauler', children: <Rows /> },
  parameters: { viewport: { viewports: VIEWPORTS, defaultViewport: 'phoneLandscape' } },
};
