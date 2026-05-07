import { Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';
import { WEAPON_IDS, getWeapon, type WeaponId } from '../../core/combat/WeaponCatalogue';

const HOTKEYS: Record<WeaponId, string> = {
  hitscan: '1',
  laser: '2',
};

const WEAPON_COLORS: Record<WeaponId, string> = {
  hitscan: '#00eeff',
  laser: '#ff2244',
};

export function WeaponSelector(): JSX.Element {
  const activeWeapon = useUIStore((s) => s.activeWeapon);
  const isDead = useUIStore((s) => s.isDead);
  const setActiveWeapon = useUIStore((s) => s.setActiveWeapon);

  if (isDead) return <></>;

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
