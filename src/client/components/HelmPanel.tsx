import { Box, ButtonBase } from '@mui/material';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { getGameClient } from '../net/clientSingleton';

/**
 * Helm orders (capital-ship R&D round 3 D). Shown only while you fly a ship
 * that takes helm orders (a capital). Tap empty space to set the course; these
 * buttons set the speed: stop, one third, two thirds, full. WASD overrides and
 * cancels the course. Reads only discrete Zustand state (#2).
 */
const LABELS = ['Stop', '⅓', '⅔', 'Full'] as const;

const ROOT_SX = {
  display: 'flex',
  alignItems: 'center',
  columnGap: '4px',
  padding: '4px 6px',
  borderRadius: '6px',
  backgroundColor: 'rgba(10,16,28,0.72)',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 12,
  color: '#cfe3ff',
  pointerEvents: 'auto' as const,
};
const LABEL_SX = { opacity: 0.75, marginRight: '4px' };
const BTN_SX = {
  minWidth: 38,
  height: 26,
  borderRadius: '4px',
  fontSize: 12,
  color: '#cfe3ff',
  border: '1px solid rgba(160,200,255,0.35)',
};
const BTN_ON_SX = { ...BTN_SX, backgroundColor: 'rgba(90,160,255,0.45)', color: '#fff' };

export function HelmPanel(): JSX.Element | null {
  const show = useShouldRenderHud();
  const available = useUIStore((s) => s.helmAvailable);
  const active = useUIStore((s) => s.helmActive);
  const speed = useUIStore((s) => s.helmSpeed);
  if (!show || !available) return null;
  return (
    <Box sx={ROOT_SX} data-testid="helm-panel" data-helm-active={active ? '1' : '0'} data-helm-speed={speed}>
      <Box component="span" sx={LABEL_SX}>{active ? 'Helm: on course' : 'Helm: tap to set course'}</Box>
      {LABELS.map((label, i) => (
        <ButtonBase
          key={label}
          sx={i === speed ? BTN_ON_SX : BTN_SX}
          data-testid={`helm-speed-${i}`}
          onClick={() => getGameClient()?.setHelmSpeed(i as 0 | 1 | 2 | 3)}
        >
          {label}
        </ButtonBase>
      ))}
    </Box>
  );
}
