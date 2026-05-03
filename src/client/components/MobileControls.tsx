import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import nipplejs from 'nipplejs';
import type { TouchInput } from '../input/TouchInput';

interface Props {
  touchInput: TouchInput;
}

/**
 * Virtual joystick (bottom-left) and fire button (bottom-right) for touch devices.
 * zIndex 15: above canvas (0) and HUD (10), below DeathOverlay (20).
 * All elements use touch-action:'none' to prevent page scroll interference.
 */
export function MobileControls({ touchInput }: Props): JSX.Element {
  const joystickZoneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const zone = joystickZoneRef.current;
    if (!zone) return;

    const manager = nipplejs.create({
      zone,
      mode: 'static',
      position: { left: '50%', top: '50%' },
      size: 100,
      // Translucent so the playfield is still visible behind, but clearly visible.
      color: { back: 'rgba(255,255,255,0.18)', front: 'rgba(0,255,136,0.55)' },
      restOpacity: 1,
      fadeTime: 150,
    });

    manager.on('move', (evt) => {
      touchInput.setJoystick(evt.data.vector);
    });

    manager.on('end', () => {
      touchInput.setJoystickIdle();
    });

    return () => {
      manager.destroy();
      touchInput.setJoystickIdle();
      touchInput.setFireHeld(false);
    };
  }, [touchInput]);

  const onFireStart = (e: React.TouchEvent): void => {
    e.preventDefault();
    touchInput.setFireHeld(true);
  };

  const onFireEnd = (e: React.TouchEvent): void => {
    e.preventDefault();
    touchInput.setFireHeld(false);
  };

  return (
    <>
      <Box
        ref={joystickZoneRef}
        sx={{
          position: 'fixed',
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 28px)',
          left: 'calc(env(safe-area-inset-left, 0px) + 28px)',
          width: 120,
          height: 120,
          zIndex: 15,
          touchAction: 'none',
          bgcolor: 'transparent',
          borderRadius: '50%',
        }}
      />

      <Box
        component="button"
        onTouchStart={onFireStart}
        onTouchEnd={onFireEnd}
        onTouchCancel={onFireEnd}
        sx={{
          position: 'fixed',
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 32px)',
          right: 'calc(env(safe-area-inset-right, 0px) + 32px)',
          width: 76,
          height: 76,
          zIndex: 15,
          touchAction: 'none',
          borderRadius: '50%',
          bgcolor: 'rgba(0, 255, 136, 0.12)',
          border: '1.5px solid rgba(0, 255, 136, 0.55)',
          color: 'rgba(0, 255, 136, 0.95)',
          fontSize: 10,
          fontFamily: 'monospace',
          fontWeight: 700,
          letterSpacing: 1,
          textTransform: 'uppercase',
          cursor: 'pointer',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          '&:active': {
            bgcolor: 'rgba(0, 255, 136, 0.18)',
            border: '1px solid rgba(0, 255, 136, 0.7)',
            color: '#00ff88',
          },
        }}
      >
        FIRE
      </Box>
    </>
  );
}
