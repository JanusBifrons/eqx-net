import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import nipplejs from 'nipplejs';
import type { TouchInput } from '../input/TouchInput';
import { Slot } from '../layout/Slot';
import { WeaponSelector } from './WeaponSelector';

interface Props {
  touchInput: TouchInput;
}

/**
 * Virtual joystick + fire/boost for touch devices.
 *
 * Each control is portalled into a layout anchor by `<Slot>` — this
 * component does not set its own positioning, z-index, or safe-area insets.
 * The slot host owns all of that.
 *
 *   - Joystick   → `bottom-left` (left thumb)
 *   - FIRE       → `bottom-right` (right thumb, rightmost via row-reverse)
 *   - BOOST      → `bottom-right` (right thumb, left of FIRE)
 *
 * The galaxy-map shortcut used to live here as a top-center MAP button;
 * that moved into the AdvancedDrawer's Galaxy tab in Phase 2 of the layout
 * rework. The `M` keyboard shortcut still toggles the map.
 */
export function MobileControls({ touchInput }: Props): JSX.Element {
  // The joystick zone lives inside a `<Slot>` portal whose host doesn't
  // exist on the first render — `useRef` would observe `null` at the time
  // the effect first runs and skip nipplejs setup forever. A state-backed
  // callback ref re-runs the effect when the element actually attaches.
  const [zone, setZone] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!zone) return;

    // Defensive: nipplejs renders the joystick handle as children of the
    // zone element. If a previous mount's cleanup raced a Fast Refresh
    // remount (the partner's 2026-05-12 capture surfaced two stacked
    // joysticks), stale handle DOM survives and we end up with one
    // joystick per past mount. Wipe the zone first so each `create`
    // starts from an empty container.
    while (zone.firstChild) zone.removeChild(zone.firstChild);

    const manager = nipplejs.create({
      zone,
      mode: 'static',
      position: { left: '50%', top: '50%' },
      size: 100,
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
      touchInput.setBoostHeld(false);
    };
  }, [touchInput, zone]);

  const onFireStart = (e: React.TouchEvent): void => {
    e.preventDefault();
    touchInput.setFireHeld(true);
  };

  const onFireEnd = (e: React.TouchEvent): void => {
    e.preventDefault();
    touchInput.setFireHeld(false);
  };

  const onBoostStart = (e: React.TouchEvent): void => {
    e.preventDefault();
    touchInput.setBoostHeld(true);
  };

  const onBoostEnd = (e: React.TouchEvent): void => {
    e.preventDefault();
    touchInput.setBoostHeld(false);
  };

  return (
    <>
      <Slot anchor="bottom-left">
        <Box
          ref={setZone}
          data-testid="mobile-joystick"
          sx={{
            // nipplejs's joystick handle uses position:absolute and looks up
            // to its nearest positioned ancestor. The zone MUST be a
            // positioning context, otherwise the handle paints relative to
            // some far-away ancestor and disappears off-screen.
            position: 'relative',
            width: 120,
            height: 120,
            touchAction: 'none',
            bgcolor: 'transparent',
            borderRadius: '50%',
          }}
        />
      </Slot>

      {/* Right thumb cluster: WEAPON (small) sits ABOVE FIRE in a tight
       *  column; BOOST sits to the LEFT of that column. The bottom-right
       *  anchor is row-reverse, so the column wrapper (order=10) is the
       *  rightmost element and BOOST (order=20) is to its left. */}
      <Slot anchor="bottom-right" order={10}>
        <Box sx={{ display: 'flex', flexDirection: 'column-reverse', alignItems: 'center', gap: 0.75 }}>
          <Box
            component="button"
            data-testid="mobile-fire"
            onTouchStart={onFireStart}
            onTouchEnd={onFireEnd}
            onTouchCancel={onFireEnd}
            sx={fireButtonSx}
          >
            FIRE
          </Box>
          <WeaponSelector />
        </Box>
      </Slot>

      <Slot anchor="bottom-right" order={20}>
        <Box
          component="button"
          data-testid="mobile-boost"
          onTouchStart={onBoostStart}
          onTouchEnd={onBoostEnd}
          onTouchCancel={onBoostEnd}
          sx={boostButtonSx}
        >
          BOOST
        </Box>
      </Slot>
    </>
  );
}

const baseRoundButtonSx = {
  width: 76,
  height: 76,
  touchAction: 'none',
  borderRadius: '50%',
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
} as const;

const fireButtonSx = {
  ...baseRoundButtonSx,
  bgcolor: 'rgba(0, 255, 136, 0.12)',
  border: '1.5px solid rgba(0, 255, 136, 0.55)',
  color: 'rgba(0, 255, 136, 0.95)',
  '&:active': {
    bgcolor: 'rgba(0, 255, 136, 0.18)',
    border: '1px solid rgba(0, 255, 136, 0.7)',
    color: '#00ff88',
  },
};

const boostButtonSx = {
  ...baseRoundButtonSx,
  bgcolor: 'rgba(255, 140, 40, 0.12)',
  border: '1.5px solid rgba(255, 140, 40, 0.55)',
  color: 'rgba(255, 140, 40, 0.95)',
  '&:active': {
    bgcolor: 'rgba(255, 140, 40, 0.22)',
    border: '1px solid rgba(255, 165, 60, 0.85)',
    color: '#ffaa44',
  },
};
