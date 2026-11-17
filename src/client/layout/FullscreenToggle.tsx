import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, IconButton, Tooltip, Typography } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import IosShareIcon from '@mui/icons-material/IosShare';
import AddToHomeScreenIcon from '@mui/icons-material/AddToHomeScreen';
import { useFullscreen } from './useFullscreen';
import { isIOS, useStandalone } from './useStandalone';
import { isTouchDevice } from '../input/TouchInput';
import { useShouldRenderHud } from '../state/store';
import { useIsLandscape } from '../hud/useHudScale';

/** How long the 'Tap for full screen' label shows after the phone turns sideways. */
export const FULLSCREEN_HINT_MS = 8000;

/**
 * Persistent fullscreen control. Hidden on desktop (where there's no
 * browser chrome to toggle) and inside an installed PWA.
 *
 * - On Android-class browsers: tap → `requestFullscreen()` + landscape lock
 *   when entering; `exitFullscreen()` + orientation unlock when leaving.
 * - On iOS Safari: tap opens an "Add to Home Screen" dialog (the only way
 *   to remove iOS chrome is via PWA install).
 *
 * Slotting (anchor + ordering) is owned by `TopRightToolbar`; this
 * component returns the presentational chip + its install dialog fragment.
 * Returns `null` when not applicable so the toolbar lays out cleanly.
 *
 * Each time the phone turns sideways outside full screen, the chip grows a
 * 'Tap for full screen' label for FULLSCREEN_HINT_MS, then shrinks back to
 * the icon. It never enters full screen on its own.
 */
export function FullscreenToggle(): JSX.Element | null {
  // Plan: crispy-kazoo, Commit 5 — hide HUD during loading curtain.
  const shouldRender = useShouldRenderHud();
  const { isFullscreen, enterFullscreen, exitFullscreen } = useFullscreen();
  const standalone = useStandalone();
  const [installOpen, setInstallOpen] = useState(false);
  const landscape = useIsLandscape();
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!landscape || isFullscreen) {
      setHint(false);
      return;
    }
    setHint(true);
    // -- real time: a UI label timeout, not game time.
    const t = window.setTimeout(() => setHint(false), FULLSCREEN_HINT_MS);
    return () => window.clearTimeout(t);
  }, [landscape, isFullscreen]);

  const visible = !standalone && isTouchDevice();
  if (!visible) return null;
  if (!shouldRender) return null;

  const onClick = async (): Promise<void> => {
    setHint(false);
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
      <Tooltip title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
        <IconButton
          data-testid="fullscreen-toggle"
          data-fullscreen={isFullscreen ? '1' : '0'}
          data-hint={hint ? '1' : '0'}
          onClick={onClick}
          sx={{
            p: 0.5,
            px: hint ? 1.25 : 0.5,
            gap: 0.75,
            borderRadius: 999,
            opacity: hint ? 1 : 0.55,
            // backdropFilter removed 2026-05-13 — GPU readPixels stall.
            bgcolor: 'rgba(5,7,15,0.75)',
            border: hint ? '1px solid rgba(0,255,136,0.55)' : '1px solid rgba(255,255,255,0.10)',
            color: '#dde',
            transition: 'opacity 120ms, background 120ms',
            '&:hover, &:focus, &:active': {
              opacity: 1,
              bgcolor: 'rgba(5,7,15,0.65)',
            },
          }}
        >
          {isFullscreen
            ? <FullscreenExitIcon sx={{ fontSize: 16 }} />
            : <FullscreenIcon sx={{ fontSize: 16, color: hint ? '#00ff88' : undefined }} />}
          {hint && (
            <Typography component="span" sx={{ fontSize: 13, letterSpacing: 0.5, whiteSpace: 'nowrap' }}>
              Tap for full screen
            </Typography>
          )}
        </IconButton>
      </Tooltip>

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
            <strong>Add to Home Screen</strong>, then launch Equinox from the icon —
            the URL bar disappears entirely.
          </Typography>
        ) : (
          <Typography variant="body2">
            Open the browser menu (⋮) and choose <strong>Install app</strong> or{' '}
            <strong>Add to Home screen</strong>, then launch Equinox from the icon
            for a true full-screen experience.
          </Typography>
        )}
      </DialogContent>
    </Dialog>
  );
}
