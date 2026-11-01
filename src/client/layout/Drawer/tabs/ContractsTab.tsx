/**
 * Living World P4c — the Contracts tab: what's worth hunting right now. Named
 * elites (with their bounty) and the running world event, each with where to
 * go. Rebuilt ONLY from `GET /galaxy/contracts` (#16), polled only while the
 * tab is on screen (drawer-perf rule). Tapping a row opens the galaxy map so
 * the pilot can warp there. No raw ids: sectors show by name.
 */
import { memo, useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { useUIStore } from '../../../state/store';
import { fetchContracts, formatReward, formatTimeLeft } from '../../../net/contractsApi';
import { sectorName } from '../../../net/tradeView';
import type { Contract } from '../../../../shared-types/contracts';

const POLL_MS = 4000;

const ROW_SX = {
  p: 0.75,
  mb: 0.5,
  borderRadius: '3px',
  border: '1px solid rgba(255,255,255,0.12)',
  backgroundColor: 'rgba(255,255,255,0.03)',
  cursor: 'pointer',
  '&:hover': { backgroundColor: 'rgba(255,255,255,0.07)' },
} as const;
const TITLE_SX = { fontSize: 12, fontWeight: 700, lineHeight: 1.2 } as const;
const ELITE_COLOR = '#ffc850';
const EVENT_COLOR = '#ff9f43';
const PLAYER_COLOR = '#ff6b6b';
const DETAIL_SX = { fontSize: 10, color: '#9aa0b4' } as const;
const META_SX = { fontSize: 10, color: '#dde3ef', display: 'flex', gap: 1, mt: 0.25 } as const;

function colorFor(c: Contract): string {
  return c.kind === 'elite' ? ELITE_COLOR : c.kind === 'event' ? EVENT_COLOR : PLAYER_COLOR;
}

export const ContractsTab = memo(function ContractsTab(): JSX.Element {
  const visible = useUIStore((s) => s.drawerTab === 'contracts' && s.isDrawerOpen);
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const c = await fetchContracts();
      if (cancelled) return;
      if (c !== null) setContracts(c);
      setNow(Date.now());
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [visible]);

  const openMap = (): void => {
    const st = useUIStore.getState();
    st.setDrawerOpen(false);
    st.setGalaxyMapOpen(true);
  };

  return (
    <Box sx={{ p: 1 }} data-testid="contracts-tab">
      <Typography sx={{ fontSize: 13, fontWeight: 700, color: '#dffff0', mb: 0.75 }}>Contracts</Typography>
      {contracts === null && <Typography sx={DETAIL_SX}>Loading…</Typography>}
      {contracts !== null && contracts.length === 0 && (
        <Typography sx={DETAIL_SX} data-testid="contracts-empty">
          Nothing on the board right now. Elites and events appear every few minutes.
        </Typography>
      )}
      {contracts?.map((c) => (
        <Box
          key={c.id}
          sx={ROW_SX}
          onClick={openMap}
          data-testid="contract-row"
          data-contract-kind={c.kind}
          data-contract-sector={c.sectorKey}
        >
          <Typography sx={{ ...TITLE_SX, color: colorFor(c) }}>
            {c.kind === 'elite' ? '★ ' : c.kind === 'event' ? '⚑ ' : '☠ '}
            {c.title}
          </Typography>
          <Typography sx={DETAIL_SX}>{c.detail}</Typography>
          <Box sx={META_SX}>
            <span>{c.sectorKey === '' ? 'Location unknown' : sectorName(c.sectorKey)}</span>
            <span style={{ color: ELITE_COLOR }}>{formatReward(c)}</span>
            {c.endsAtMs !== null && <span style={{ color: '#9aa0b4' }}>{formatTimeLeft(c.endsAtMs, now)} left</span>}
          </Box>
        </Box>
      ))}
    </Box>
  );
});
