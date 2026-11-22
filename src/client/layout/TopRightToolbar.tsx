import { Box } from '@mui/material';
import { Slot } from './Slot';
import { FullscreenToggle } from './FullscreenToggle';

/**
 * Single top-right anchor mount for the in-game toggle row: today just the
 * fullscreen toggle (touch + non-standalone; it returns null on desktop / PWA).
 * The ☰ drawer button went: the right rail opens every panel
 * (layout/RightPanelHost.tsx). The fullscreen button goes with first-tap full
 * screen (UI language plan U5-3).
 */
export function TopRightToolbar(): JSX.Element {
  return (
    <Slot anchor="top-right" order={1}>
      <Box
        data-testid="top-right-toolbar"
        sx={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 0.5,
        }}
      >
        <FullscreenToggle />
      </Box>
    </Slot>
  );
}
