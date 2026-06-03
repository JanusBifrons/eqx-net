import { useEffect, useRef } from 'react';
import { Box } from '@mui/material';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { getGameClient } from '../net/clientSingleton';

/**
 * Prominent top-center energy readout (weapons/energy/AI overhaul §5.1).
 *
 * Energy is the local player's PREDICTED resource (regen + fire/boost drain),
 * so — unlike the shield/hull bars which tween between discrete Zustand
 * anchors — the fill is driven by a RAF loop reading
 * `getGameClient().getPredictedEnergy()` and writing a CSS width directly on a
 * ref'd `<div>` (the `FireCooldownRing` precedent). NO per-frame Zustand
 * write (Invariant #2). `energyMax` (the constant-per-kind denominator) is
 * the one Zustand read, set once on spawn.
 *
 * Distinct amber/gold colour from hull (green) / shield (cyan). The
 * `data-energy-pct` attribute is the E2E hook (mirrors `data-shield-pct`).
 */
const TRACK_W = 132;
const BAR_H = 7;
const ENERGY_COLOR = '#ffc23d'; // amber/gold

const ROOT_SX = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  rowGap: '2px',
  pointerEvents: 'none' as const,
  userSelect: 'none' as const,
  fontFamily: 'system-ui, sans-serif',
};
const TRACK_SX = {
  width: TRACK_W,
  height: BAR_H,
  borderRadius: '3px',
  backgroundColor: 'rgba(255,255,255,0.12)',
  overflow: 'hidden' as const,
  boxShadow: '0 0 6px rgba(255,194,61,0.35)',
};
const FILL_SX = {
  height: '100%',
  width: '100%',
  backgroundColor: ENERGY_COLOR,
  transformOrigin: 'left center',
  willChange: 'transform',
};
const CAP_SX = {
  fontSize: 8,
  letterSpacing: 1,
  color: 'rgba(255,255,255,0.5)',
  textTransform: 'uppercase' as const,
};

export function EnergyBar(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const energyMax = useUIStore((s) => s.energyMax);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!shouldRender) return;
    let rafId = 0;
    let lastPctInt = -1;
    const max = energyMax > 0 ? energyMax : 1;
    const tick = (): void => {
      const energy = getGameClient()?.getPredictedEnergy() ?? 0;
      const pct = Math.max(0, Math.min(1, energy / max));
      const fill = fillRef.current;
      // Use scaleX (compositor-only) for the per-frame write; cheaper than
      // animating `width`.
      if (fill) fill.style.transform = `scaleX(${pct})`;
      // Only touch the E2E attribute when the rounded percent changes — keeps
      // attribute mutations off the per-frame hot path.
      const pctInt = Math.round(pct * 100);
      if (pctInt !== lastPctInt) {
        lastPctInt = pctInt;
        rootRef.current?.setAttribute('data-energy-pct', String(pctInt));
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [shouldRender, energyMax]);

  if (!shouldRender) return null;
  return (
    <Box ref={rootRef} data-testid="energy-bar" data-energy-pct={100} sx={ROOT_SX}>
      <Box component="span" sx={CAP_SX}>Energy</Box>
      <Box sx={TRACK_SX}>
        <Box ref={fillRef} sx={FILL_SX} />
      </Box>
    </Box>
  );
}
