/**
 * Economy v2 W1 — the WALLET chip: the player's one credit balance (`¢ 12,345`).
 *
 * Credits are virtual (Eve-style): never cargo, never dropped, stolen or lost.
 * The balance comes ONLY from the authoritative own-ship snapshot `wallet`
 * field (#16), written to the store when it changes — so a late joiner, a
 * dropped event or a sector change all converge to the right number.
 */
import { memo } from 'react';
import { Box } from '@mui/material';
import { useUIStore, useShouldRenderHud } from '../state/store';

const CHIP_SX = {
  px: 0.75,
  py: '2px',
  borderRadius: '3px',
  border: '1px solid rgba(255,208,96,0.45)',
  backgroundColor: 'rgba(0,0,0,0.55)',
  color: '#ffd060',
  fontSize: { xs: 10, sm: 12 },
  fontFamily: 'system-ui, sans-serif',
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none' as const,
  whiteSpace: 'nowrap' as const,
} as const;

/** "¢ 12,345" — the HUD format (en-US grouping so tests are stable). */
export function formatWallet(credits: number): string {
  return `¢ ${Math.max(0, Math.floor(credits)).toLocaleString('en-US')}`;
}

export const WalletChip = memo(function WalletChip(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const wallet = useUIStore((s) => s.wallet);
  if (!shouldRender || wallet === null) return null;
  return (
    <Box sx={CHIP_SX} data-testid="wallet-chip" data-wallet={wallet}>
      {formatWallet(wallet)}
    </Box>
  );
});
