import Box from '@mui/material/Box';
import { useUIStore, useShouldRenderHud } from '../state/store';

/**
 * Auto-fire mode toggle (weapon-autofire-boost-mechanics, Part B4).
 *
 * Small always-visible chip. When ON (the default) weapons auto-fire at in-range
 * hostiles and the manual FIRE button (touch) is hidden — see `MobileControls`,
 * which gates the FIRE slot on `!autoFireEnabled`. When OFF, the original manual
 * fire behaviour (FIRE button / Space) returns. Works on click (desktop) and tap
 * (touch). Reads/writes the persisted `autoFireEnabled` Zustand flag.
 *
 * Hidden during the loading curtain (`useShouldRenderHud`) and while dead — same
 * lifecycle as the rest of the in-game HUD.
 */
export function AutoFireToggleButton(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const isDead = useUIStore((s) => s.isDead);
  const autoFireEnabled = useUIStore((s) => s.autoFireEnabled);
  const setAutoFireEnabled = useUIStore((s) => s.setAutoFireEnabled);

  if (!shouldRender || isDead) return null;

  const toggle = (): void => setAutoFireEnabled(!autoFireEnabled);

  return (
    <Box
      component="button"
      data-testid="auto-fire-toggle"
      data-state={autoFireEnabled ? 'on' : 'off'}
      aria-pressed={autoFireEnabled}
      // `onClick` ONLY — a discrete toggle, not a held control. A tap fires a
      // single click on every platform; adding `onTouchStart` (even with
      // preventDefault) double-toggled on touch contexts (touchstart + a
      // still-delivered click), which flipped auto-fire straight back ON — the
      // CI layout-slots failure. The FIRE/BOOST buttons keep onTouchStart
      // because they are press-and-HOLD; this is a single-shot toggle.
      onClick={toggle}
      sx={autoFireEnabled ? autoOnSx : autoOffSx}
    >
      AUTO
    </Box>
  );
}

const baseSx = {
  width: 56,
  height: 56,
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

// ON: filled cyan (active mode). OFF: dim outline (manual mode).
const autoOnSx = {
  ...baseSx,
  bgcolor: 'rgba(0, 200, 255, 0.22)',
  border: '1.5px solid rgba(0, 200, 255, 0.85)',
  color: '#33ddff',
};

const autoOffSx = {
  ...baseSx,
  bgcolor: 'rgba(120, 130, 140, 0.10)',
  border: '1.5px solid rgba(150, 160, 170, 0.45)',
  color: 'rgba(170, 180, 190, 0.85)',
};
