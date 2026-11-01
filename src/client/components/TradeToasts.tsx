/**
 * Living World P2b — trade toasts ("Your hauler is under fire!", "Sold 20
 * Salvage for 95 cr"). Top-centre, under the warp banner. Driven by the
 * discrete `tradeToasts` Zustand queue (pushed from `trade_notice`, auto-
 * expired) — never per frame. A DANGER toast (under fire / raided) is the
 * escort prompt: tapping it opens the Trade tab. A gold `world` toast is a
 * galaxy-wide world notice (P4 — an elite sighted / destroyed).
 */
import { memo } from 'react';
import { Box } from '@mui/material';
import { useUIStore } from '../state/store';
import type { TradeToastTone } from '../state/storeTypes';

const STACK_SX = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  gap: '3px',
  pointerEvents: 'none' as const,
};

const TONE_SX: Record<TradeToastTone, object> = {
  good: { borderColor: 'rgba(95,214,160,0.7)', color: '#bff5d8' },
  info: { borderColor: 'rgba(255,255,255,0.25)', color: '#dde3ef' },
  danger: { borderColor: 'rgba(255,90,90,0.85)', color: '#ffd0d0', backgroundColor: 'rgba(60,0,0,0.7)' },
  world: { borderColor: 'rgba(255,200,80,0.85)', color: '#ffe6a8', backgroundColor: 'rgba(40,28,0,0.7)' },
};

const BASE_SX = {
  px: 1,
  py: '2px',
  borderRadius: '3px',
  border: '1px solid',
  backgroundColor: 'rgba(0,0,0,0.6)',
  fontSize: { xs: 10, sm: 12 },
  fontFamily: 'system-ui, sans-serif',
  maxWidth: 'min(80vw, 420px)',
  pointerEvents: 'auto' as const,
  cursor: 'pointer',
};

const SX_BY_TONE: Record<TradeToastTone, object> = {
  good: { ...BASE_SX, ...TONE_SX.good },
  info: { ...BASE_SX, ...TONE_SX.info },
  danger: { ...BASE_SX, ...TONE_SX.danger },
  world: { ...BASE_SX, ...TONE_SX.world },
};

export const TradeToasts = memo(function TradeToasts(): JSX.Element | null {
  const toasts = useUIStore((s) => s.tradeToasts);
  if (toasts.length === 0) return null;
  const openTrade = (): void => {
    const st = useUIStore.getState();
    st.setDrawerTab('trade');
    st.setDrawerOpen(true);
  };
  return (
    <Box sx={STACK_SX} data-testid="trade-toasts">
      {toasts.map((t) => (
        <Box
          key={t.id}
          sx={SX_BY_TONE[t.tone]}
          data-testid="trade-toast"
          data-tone={t.tone}
          onClick={t.tone === 'world' ? undefined : openTrade}
        >
          {t.text}
        </Box>
      ))}
    </Box>
  );
});
