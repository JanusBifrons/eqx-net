import { Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { WEAPON_IDS, getWeapon, type WeaponId } from '../../core/combat/WeaponCatalogue';
import { isTouchDevice } from '../input/TouchInput';

const HOTKEYS: Record<WeaponId, string> = {
  hitscan: '1',
  laser: '2',
};

const WEAPON_COLORS: Record<WeaponId, string> = {
  hitscan: '#00eeff',
  laser: '#ff2244',
};

const IS_TOUCH = isTouchDevice();

export function WeaponSelector(): JSX.Element {
  const activeWeapon = useUIStore((s) => s.activeWeapon);
  const isDead = useUIStore((s) => s.isDead);
  const setActiveWeapon = useUIStore((s) => s.setActiveWeapon);
  const cycleWeapon = useUIStore((s) => s.cycleWeapon);

  if (isDead) return <></>;

  if (IS_TOUCH) {
    const def = getWeapon(activeWeapon);
    const color = WEAPON_COLORS[activeWeapon] ?? '#888';
    return (
      <Box
        component="button"
        onTouchStart={(e) => {
          e.preventDefault();
          cycleWeapon();
        }}
        sx={{
          position: 'fixed',
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10,
          width: 72,
          height: 72,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          border: `2px solid ${color}`,
          borderRadius: 1,
          bgcolor: 'rgba(0,0,0,0.55)',
          boxShadow: `0 0 12px ${color}`,
          color,
          padding: 0,
          touchAction: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          cursor: 'pointer',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}
      >
        <Typography
          sx={{
            color,
            fontSize: 12,
            fontWeight: 700,
            lineHeight: 1.2,
            textTransform: 'uppercase',
            fontFamily: 'monospace',
            letterSpacing: 1,
          }}
        >
          {def.displayName}
        </Typography>
        <Typography
          sx={{
            color: 'rgba(255,255,255,0.55)',
            fontSize: 10,
            fontFamily: 'monospace',
            mt: 0.25,
          }}
        >
          ↻ NEXT
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10,
        display: 'flex',
        gap: 1,
        pointerEvents: 'auto',
      }}
    >
      {WEAPON_IDS.map((id) => {
        const def = getWeapon(id);
        const active = id === activeWeapon;
        const color = WEAPON_COLORS[id] ?? '#888';
        return (
          <Box
            key={id}
            onClick={() => setActiveWeapon(id)}
            sx={{
              width: 56,
              height: 56,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              border: active ? `2px solid ${color}` : '2px solid rgba(255,255,255,0.2)',
              borderRadius: 1,
              bgcolor: active ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.5)',
              boxShadow: active ? `0 0 12px ${color}` : 'none',
              cursor: 'pointer',
              touchAction: 'none',
              transition: 'border-color 0.15s, box-shadow 0.15s',
              '&:hover': {
                borderColor: color,
              },
            }}
          >
            <Typography
              sx={{
                color: active ? color : 'rgba(255,255,255,0.6)',
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1.2,
                textTransform: 'uppercase',
              }}
            >
              {def.displayName}
            </Typography>
            <Typography
              sx={{
                color: 'rgba(255,255,255,0.35)',
                fontSize: 9,
                fontFamily: 'monospace',
              }}
            >
              [{HOTKEYS[id]}]
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}
