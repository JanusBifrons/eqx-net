/**
 * Living World P2b — trade toasts ("Your hauler is under fire!", "Sold 20
 * Salvage for 95 cr"). Top-centre EqxPrompts, under the warp banner. Driven by
 * the discrete `tradeToasts` Zustand queue (pushed from `trade_notice`, auto-
 * expired, at most three) — never per frame. A DANGER toast (under fire /
 * raided) is the escort prompt: tapping it opens the Trade tab. A gold `world`
 * toast is a galaxy-wide world notice (P4 — an elite sighted / destroyed).
 */
import { memo } from 'react';
import { EqxPrompt, EqxPromptStack, type EqxPromptTone } from '../../ui/index.js';
import { useUIStore } from '../state/store';
import type { TradeToastTone } from '../state/storeTypes';

/** Trade tone -> prompt colour. `data-tone` keeps the trade tone (specs read it). */
const PROMPT_TONE: Readonly<Record<TradeToastTone, EqxPromptTone>> = {
  good: 'good',
  info: 'plain',
  danger: 'danger',
  world: 'gold',
};

const openTrade = (): void => {
  useUIStore.getState().setDrawerTab('trade'); // opens the Trade panel too
};

export const TradeToasts = memo(function TradeToasts(): JSX.Element | null {
  const toasts = useUIStore((s) => s.tradeToasts);
  if (toasts.length === 0) return null;
  return (
    <EqxPromptStack data-testid="trade-toasts">
      {toasts.map((t) => (
        <EqxPrompt
          key={t.id}
          tone={PROMPT_TONE[t.tone]}
          message={t.text}
          data-testid="trade-toast"
          dataAttrs={{ tone: t.tone }}
          onTap={t.tone === 'world' ? undefined : openTrade}
        />
      ))}
    </EqxPromptStack>
  );
});
