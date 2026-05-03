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
      size: 120,
      color: '#00ff88',
      restOpacity: 0.6,
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
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 32px)',
          left: 'calc(env(safe-area-inset-left, 0px) + 32px)',
          width: 140,
          height: 140,
          zIndex: 15,
          touchAction: 'none',
          bgcolor: 'rgba(0, 255, 136, 0.05)',
          borderRadius: '50%',
          border: '1px solid rgba(0, 255, 136, 0.2)',
        }}
      />

      <Box
        component="button"
        onTouchStart={onFireStart}
        onTouchEnd={onFireEnd}
        onTouchCancel={onFireEnd}
        sx={{
          position: 'fixed',
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 48px)',
          right: 'calc(env(safe-area-inset-right, 0px) + 48px)',
          width: 80,
          height: 80,
          zIndex: 15,
          touchAction: 'none',
          borderRadius: '50%',
          bgcolor: 'rgba(5, 7, 15, 0.75)',
          border: '2px solid rgba(0, 255, 136, 0.5)',
          color: '#00ff88',
          fontSize: 11,
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
            bgcolor: 'rgba(0, 255, 136, 0.25)',
            border: '2px solid #00ff88',
          },
        }}
      >
        FIRE
      </Box>
    </>
  );
}
