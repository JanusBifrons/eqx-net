/**
 * Living World P2b — "While you were away". Deals keep running offline; when a
 * signed-in player comes back into the game, this summarises what happened to
 * their trade since they last looked (settled / raided / skipped, net credits)
 * from `GET /trade/economy` — the truth, not the notices they missed (#16).
 * A localStorage watermark marks what has been seen.
 */
import { memo, useEffect, useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { loadStoredPlayerId } from '../identity/token';
import { loadToken } from '../auth/tokenStorage';
import { fetchEconomy, loadTradeLastSeen, saveTradeLastSeen } from '../net/tradeApi';
import { summarizeHistory, unseenHistory } from '../net/tradeView';
import type { TradeHistoryEntry } from '../../shared-types/economy';
import { useUIStore } from '../state/store';

const PAPER_PROPS = { sx: { bgcolor: '#0d1117', color: '#dde', border: '1px solid rgba(0,255,136,0.25)' } } as const;
const TITLE_SX = { fontSize: 14, color: '#00ff88', pb: 0.5 } as const;
const SUMMARY_SX = { fontSize: 12, mb: 1 } as const;
const ROW_SX = { fontSize: 11, color: '#9aa0b4', py: '1px' } as const;
const RAIDED_ROW_SX = { ...ROW_SX, color: '#ff8a8a' } as const;
const BTN_SX = { fontSize: 11 } as const;

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
    st.setDrawerTab('trade');
    st.setDrawerOpen(true);
  };
  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth PaperProps={PAPER_PROPS} data-testid="while-away-dialog">
      <DialogTitle sx={TITLE_SX}>While you were away</DialogTitle>
      <DialogContent>
        <Typography sx={SUMMARY_SX} data-testid="while-away-summary">{summarizeHistory(entries)}</Typography>
        <Box>
          {entries.slice(0, 6).map((e) => (
            <Typography key={`${e.dealId}-${e.atMs}`} sx={e.outcome === 'raided' ? RAIDED_ROW_SX : ROW_SX}>
              {e.note}
            </Typography>
          ))}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button size="small" sx={BTN_SX} onClick={openTrade} data-testid="while-away-open-trade">Open Trade</Button>
        <Button size="small" sx={BTN_SX} onClick={close} data-testid="while-away-close">OK</Button>
      </DialogActions>
    </Dialog>
  );
});
