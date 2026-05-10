import { useState } from 'react';
import { Box, Dialog, DialogContent, DialogTitle, IconButton, Tooltip, Typography } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import IosShareIcon from '@mui/icons-material/IosShare';
import AddToHomeScreenIcon from '@mui/icons-material/AddToHomeScreen';
import { Slot } from './Slot';
import { useFullscreen } from './useFullscreen';
import { isIOS, useStandalone } from './useStandalone';
import { isTouchDevice } from '../input/TouchInput';

interface Props {
  /** When true, the toggle is rendered as a discreet 50%-opacity icon
   *  inside the `top-right` slot. When false, render nothing. */
  inSlot?: boolean;
  /** Custom "compact" class for non-slot embedding (galaxy-map CTA wraps
   *  this in its own surface). When omitted, an `IconButton` is returned. */
  asButton?: boolean;
}

/**
 * Persistent fullscreen control.
 *
 * Visible on every touch-device screen (meta landing, login, galaxy-map,
 * in-game) AND while in fullscreen — the same icon flips to "exit" so
 * users can leave fullscreen with one tap. Hidden only on desktop pointer
 * devices and inside an installed PWA (where browser chrome is already
 * gone and there's nothing to toggle).
 *
 * - On Android-class browsers: tap → `requestFullscreen()` + landscape
 *   lock when entering; `exitFullscreen()` + orientation unlock when
 *   leaving.
 * - On iOS Safari: tap opens an "Add to Home Screen" dialog because the
 *   only way to remove iOS chrome is via PWA install.
 *
 * Renders into the `top-right` slot at order=2 (just below the
 * `DrawerToggle` at order=1) when `inSlot` is true.
 */
export function FullscreenToggle({ inSlot = true }: Props): JSX.Element | null {
  const { isFullscreen, enterFullscreen, exitFullscreen } = useFullscreen();
  const standalone = useStandalone();
  const [installOpen, setInstallOpen] = useState(false);

  // Hide on desktop / inside a PWA — there's no browser chrome to toggle
  // away from. Stays visible while in fullscreen so users can exit.
  const visible = !standalone && isTouchDevice();
  if (!visible || !inSlot) return null;

  const onClick = async (): Promise<void> => {
    if (isFullscreen) {
      await exitFullscreen();
      return;
    }
    const ok = await enterFullscreen();
    if (!ok) {
      // iOS Safari path — surface the install dialog.
      setInstallOpen(true);
    }
  };

  return (
    <>
      <Slot anchor="top-right" order={2}>
        <Tooltip title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
          <IconButton
            data-testid="fullscreen-toggle"
            data-fullscreen={isFullscreen ? '1' : '0'}
            onClick={onClick}
            size="small"
            sx={{
              opacity: 0.5,
              bgcolor: 'rgba(255,255,255,0.18)',
              color: '#fff',
              backdropFilter: 'blur(4px)',
              '&:hover, &:focus, &:active': {
                opacity: 1,
                bgcolor: 'rgba(255,255,255,0.25)',
              },
            }}
          >
            {isFullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Slot>

      <InstallDialog open={installOpen} onClose={() => setInstallOpen(false)} />
    </>
  );
}

interface InstallDialogProps {
  open: boolean;
  onClose: () => void;
}

function InstallDialog({ open, onClose }: InstallDialogProps): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" data-testid="install-dialog">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AddToHomeScreenIcon sx={{ color: '#00ff88' }} />
        Install for full-screen
      </DialogTitle>
      <DialogContent>
        {isIOS() ? (
          <Typography variant="body2">
            iOS Safari can&apos;t hide its address bar in a normal tab. Tap the{' '}
            <IosShareIcon sx={{ fontSize: 18, verticalAlign: 'text-bottom' }} /> share
            icon at the bottom of the screen, choose{' '}
            <strong>Add to Home Screen</strong>, then launch EQX Peri from the icon —
            the URL bar disappears entirely.
          </Typography>
        ) : (
          <Typography variant="body2">
            Open the browser menu (⋮) and choose <strong>Install app</strong> or{' '}
            <strong>Add to Home screen</strong>, then launch EQX Peri from the icon
            for a true full-screen experience.
          </Typography>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Standalone "Enter fullscreen" call-to-action used by the spawn-select
 * Galaxy Overview. Same behaviour as `FullscreenToggle` but rendered as a
 * prominent button with explanatory copy. Hides when the page is already
 * fullscreen or already a standalone PWA.
 */
export function FullscreenCTA(): JSX.Element | null {
  const { isFullscreen, enterFullscreen } = useFullscreen();
  const standalone = useStandalone();
  const [installOpen, setInstallOpen] = useState(false);

  if (isFullscreen || standalone) return null;

  const onClick = async (): Promise<void> => {
    const ok = await enterFullscreen();
    if (!ok) setInstallOpen(true);
  };

  return (
    <>
      <Box
        component="button"
        data-testid="fullscreen-cta"
        onClick={onClick}
        sx={{
          mx: 'auto',
          mt: 1,
          px: 2.5,
          py: 1.25,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          border: '1px solid rgba(0, 255, 136, 0.45)',
          bgcolor: 'rgba(0, 255, 136, 0.08)',
          color: '#dde',
          borderRadius: 999,
          cursor: 'pointer',
          fontSize: 13,
          fontFamily: 'inherit',
          letterSpacing: 0.5,
          transition: 'background 120ms, border-color 120ms',
          '&:hover, &:active': {
            bgcolor: 'rgba(0, 255, 136, 0.16)',
            borderColor: '#00ff88',
          },
        }}
      >
        <FullscreenIcon sx={{ fontSize: 20, color: '#00ff88' }} />
        <span>
          Tap for full-screen <span style={{ color: '#9aa0b4' }}>(landscape recommended)</span>
        </span>
      </Box>

      <InstallDialog open={installOpen} onClose={() => setInstallOpen(false)} />
    </>
  );
}
