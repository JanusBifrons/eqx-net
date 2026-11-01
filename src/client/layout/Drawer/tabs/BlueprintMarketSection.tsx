/**
 * Economy v2 W6 — the Trade tab's Blueprints section: traders' blueprints for
 * sale (Buy) and the blueprints in the selected base (Sell). Rebuilt ONLY from
 * the server's `bp_market_state` replies (#16): it asks on mount, every few
 * seconds while on screen, and after each action. Names only, never ids.
 */
import { memo, useEffect } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useUIStore } from '../../../state/store';
import { sendBpBuy, sendBpMarketQuery, sendBpSell } from '../../../net/tradeClient';
import type { BpListing } from '../../../../shared-types/blueprintMarket';

export const BP_MARKET_POLL_MS = 3000;

const ROW_SX = { display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25, borderBottom: '1px solid rgba(255,255,255,0.06)' };
const MAIN_SX = { flex: 1, minWidth: 0 };
const MUTED_SX = { fontSize: 9, color: '#9aa0b4' };
const HEAD_SX = { fontSize: 10, fontWeight: 700, color: '#b9a6ff', mt: 0.75, mb: 0.25 };
const BTN_SX = { fontSize: 10, minWidth: 0, px: 0.75, py: 0 };

function stars(quality: number): string {
  const n = Math.max(0, Math.min(5, Math.round(quality / 20)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/** "Original" or "Copy · 4 runs", then the stats. */
export function listingLine(b: BpListing): string {
  const kind = b.kind === 'bpo' ? 'Original' : `Copy · ${b.runs ?? 0} run${b.runs === 1 ? '' : 's'}`;
  return `${kind} · −${b.material}% mats · Q${b.output}`;
}

function Row({ b, action, testid, onClick }: { b: BpListing; action: string; testid: string; onClick: () => void }): JSX.Element {
  return (
    <Box sx={ROW_SX} data-testid={testid} data-id={b.id}>
      <Box sx={MAIN_SX}>
        <Typography sx={{ fontSize: 11 }}>{b.name} {stars(b.quality)}</Typography>
        <Typography sx={MUTED_SX}>{listingLine(b)}</Typography>
      </Box>
      <Button size="small" sx={BTN_SX} onClick={onClick} disabled={b.price <= 0} data-testid={`${testid}-action`}>
        {action} {b.price.toLocaleString('en-US')}¢
      </Button>
    </Box>
  );
}

export const BlueprintMarketSection = memo(function BlueprintMarketSection({ baseId }: { baseId: number | null }): JSX.Element {
  const state = useUIStore((s) => (s.bpMarket !== null && s.bpMarket.networkEntityId === baseId ? s.bpMarket : null));

  useEffect(() => {
    if (baseId === null) return;
    sendBpMarketQuery(baseId);
    const t = setInterval(() => sendBpMarketQuery(baseId), BP_MARKET_POLL_MS);
    return () => clearInterval(t);
  }, [baseId]);

  if (baseId === null) {
    return <Typography sx={MUTED_SX}>Build a Capital or Cargo Bay here to trade blueprints.</Typography>;
  }
  if (state === null) return <Typography sx={MUTED_SX}>Loading…</Typography>;
  return (
    <Box data-testid="bp-market">
      {state.message !== undefined && (
        <Typography data-testid="bp-market-message" sx={{ fontSize: 10, color: state.ok ? '#9be59b' : '#ff8a8a' }}>
          {state.message}
        </Typography>
      )}
      <Typography sx={HEAD_SX}>Traders sell</Typography>
      {state.offers.length === 0 && <Typography sx={MUTED_SX}>Nothing for sale right now.</Typography>}
      {state.offers.map((b) => (
        <Row key={b.id} b={b} action="Buy" testid="bp-offer" onClick={() => sendBpBuy(baseId, b.id)} />
      ))}
      <Typography sx={HEAD_SX}>Your blueprints here</Typography>
      {state.mine.length === 0 && <Typography sx={MUTED_SX}>None in this base.</Typography>}
      {state.mine.map((b) => (
        <Row key={b.id} b={b} action="Sell" testid="bp-mine" onClick={() => sendBpSell(baseId, b.id)} />
      ))}
    </Box>
  );
});
