/**
 * Living World P2b — "While you were away". Deals keep running offline; when a
 * signed-in player comes back into the game, this summarises what happened to
 * their trade since they last looked (settled / raided / skipped, net credits)
 * from `GET /trade/economy` — the truth, not the notices they missed (#16).
 * A localStorage watermark marks what has been seen. Drawn in the one Window
 * (`EqxWindow`): full screen on a phone, centred on desktop.
 */
import { memo, useEffect, useState, type CSSProperties } from 'react';
import { EqxButton, EqxWindow } from '../../ui/index.js';
import { HUD } from '../hud/tokens';
import { loadStoredPlayerId } from '../identity/token';
import { loadToken } from '../auth/tokenStorage';
import { fetchEconomy, loadTradeLastSeen, saveTradeLastSeen } from '../net/tradeApi';
import { summarizeHistory, unseenHistory } from '../net/tradeView';
import type { TradeHistoryEntry } from '../../shared-types/economy';
import { useUIStore } from '../state/store';

const W = HUD.window;
const BODY_STYLE: CSSProperties = { padding: `${W.padY}px ${W.padX}px`, fontSize: W.font, color: HUD.color.ink };
const SUMMARY_STYLE: CSSProperties = { margin: `0 0 ${W.padY}px` };
const ROW_STYLE: CSSProperties = { margin: 0, padding: '1px 0', fontSize: W.smallFont, color: HUD.color.inkDim };
const RAIDED_ROW_STYLE: CSSProperties = { ...ROW_STYLE, color: HUD.color.danger };
const GROW_STYLE: CSSProperties = { flex: 1 };

export const WhileAwayDialog = memo(function WhileAwayDialog(): JSX.Element | null {
  const [entries, setEntries] = useState<TradeHistoryEntry[]>([]);
  const phase = useUIStore((s) => s.phase);

  useEffect(() => {
    if (phase !== 'game') return;
    const pid = loadStoredPlayerId();
    if (!pid || !loadToken()) return; // trade needs an account
    let cancelled = false;
    void fetchEconomy(pid).then((view) => {
      if (cancelled || view === null) return;
      const unseen = unseenHistory(view.history, loadTradeLastSeen());
      if (unseen.length > 0) setEntries(unseen);
    });
    return () => { cancelled = true; };
  }, [phase]);

  if (entries.length === 0) return null;
  const close = (): void => {
    saveTradeLastSeen(Date.now());
    setEntries([]);
  };
  const openTrade = (): void => {
    close();
    const st = useUIStore.getState();
    st.setDrawerTab('trade'); // opens the Trade panel too
  };
  return (
    <EqxWindow
      open onClose={close} testId="while-away-dialog" closeTestId="while-away-x" title="While you were away"
      footer={(
        <>
          <span style={GROW_STYLE} />
          <EqxButton onClick={openTrade} data-testid="while-away-open-trade">Open Trade</EqxButton>
          <EqxButton tone="primary" onClick={close} data-testid="while-away-close">OK</EqxButton>
        </>
      )}
    >
      <div style={BODY_STYLE}>
        <p style={SUMMARY_STYLE} data-testid="while-away-summary">{summarizeHistory(entries)}</p>
        {entries.slice(0, 6).map((e) => (
          <p key={`${e.dealId}-${e.atMs}`} style={e.outcome === 'raided' ? RAIDED_ROW_STYLE : ROW_STYLE}>{e.note}</p>
        ))}
      </div>
    </EqxWindow>
  );
});
