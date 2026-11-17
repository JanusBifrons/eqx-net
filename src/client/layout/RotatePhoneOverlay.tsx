import { Box, Typography } from '@mui/material';
import { keyframes } from '@mui/system';
import ScreenRotationIcon from '@mui/icons-material/ScreenRotation';
import { useHudSize, useIsLandscape } from '../hud/useHudScale';
import { Slot } from './Slot';

/**
 * True while a phone is held upright. The game is played sideways on phones:
 * upright, the whole screen asks the player to turn the phone and input is
 * off (App.tsx gates it with the loading curtain). Tablets and desktops are
 * never asked (`useHudSize` keys on pointer type and the screen's short side).
 * Guide: docs/features/mobile-layout.md "Orientation policy".
 */
export function useNeedsRotate(): boolean {
  const size = useHudSize();
  const landscape = useIsLandscape();
  return size === 'phone' && !landscape;
}

const turn = keyframes`
  0%, 20%   { transform: rotate(0deg); }
  55%, 85%  { transform: rotate(-90deg); }
  100%      { transform: rotate(0deg); }
`;

/**
 * Full-screen "turn your phone sideways" picture, shown on an upright phone,
 * in the browser and in the installed app alike (the installed iPhone app
 * cannot lock orientation; the Android one is locked by the manifest and
 * never shows it). Sits above the galaxy map and dialogs, below the
 * lost-connection and error overlays (the `rotate` anchor tier).
 */
export function RotatePhoneOverlay(): JSX.Element | null {
  const needsRotate = useNeedsRotate();
  if (!needsRotate) return null;
  return (
    <Slot anchor="rotate">
      <Box
        data-testid="rotate-phone-overlay"
        role="alert"
        sx={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          px: 4,
          textAlign: 'center',
          bgcolor: '#05070f',
          backgroundImage:
            'radial-gradient(circle at 50% 40%, rgba(0,255,136,0.10), transparent 60%)',
          color: '#dde',
          touchAction: 'none',
        }}
      >
        <Box
          aria-hidden
          sx={{
            width: 64,
            height: 112,
            borderRadius: '12px',
            border: '3px solid #00ff88',
            boxShadow: '0 0 24px rgba(0,255,136,0.35)',
            position: 'relative',
            animation: `${turn} 2.4s ease-in-out infinite`,
            '@media (prefers-reduced-motion: reduce)': {
              animation: 'none',
              transform: 'rotate(-90deg)',
            },
            '&::after': {
              content: '""',
              position: 'absolute',
              left: '50%',
              bottom: 6,
              width: 14,
              height: 3,
              ml: '-7px',
              borderRadius: 2,
              bgcolor: '#00ff88',
            },
          }}
        />
        <Box sx={{ display: 'grid', gap: 1 }}>
          <Typography
            sx={{
              fontWeight: 700,
              letterSpacing: 3,
              textTransform: 'uppercase',
              fontSize: '1.25rem',
            }}
          >
            Turn your phone sideways
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: '#9aa0b4',
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              justifyContent: 'center',
            }}
          >
            <ScreenRotationIcon sx={{ fontSize: 18 }} />
            Equinox is played in landscape
          </Typography>
        </Box>
      </Box>
    </Slot>
  );
}
