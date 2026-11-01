/**
 * Living World P4c-2 — "put a bounty on this pilot". Rendered by the entity
 * inspector for a selected REMOTE player ship. A tiny toggle opens three price
 * chips; each shows the full cost (bounty + burned fee). The price is paid
 * from the pilot's WALLET (economy v2 — credits are virtual; any sector).
 * The server decides everything; its verdict comes back as `bounty_result` (a
 * toast) and the Contracts tab shows the live board. No raw ids are shown.
 */
import { memo, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import { useUIStore } from '../state/store';
import { sendPlaceBounty } from '../net/tradeClient';
import { pvpBountyCost } from '../../shared-types/contracts';

export const BOUNTY_PRESETS = [100, 500, 1000] as const;

const ROW_SX = { display: 'flex', gap: '4px', alignItems: 'center', pointerEvents: 'auto' as const, mt: 0.5 };
const CHIP_SX = {
  px: 0.75,
  py: '2px',
  borderRadius: '3px',
  border: '1px solid rgba(255,107,107,0.7)',
  color: '#ffd0d0',
  backgroundColor: 'rgba(60,0,0,0.6)',
  fontSize: 10,
  cursor: 'pointer',
  userSelect: 'none' as const,
};
const BTN_SX = { color: '#ff6b6b', p: 0.5 };
const ICON_SX = { fontSize: { xs: 16, sm: 22 } };

/** Place a bounty of `amount` on `targetPlayerId`, paid from the wallet.
 *  Returns false (with a toast) when the wallet can't cover it. */
export function placeBountyFromHere(targetPlayerId: string, amount: number): boolean {
  const wallet = useUIStore.getState().wallet ?? 0;
  const cost = pvpBountyCost(amount);
  if (wallet < cost) {
    const id = useUIStore.getState().pushTradeToast(`That bounty costs ${cost}¢ — you have ${wallet}¢.`, 'danger', false);
    setTimeout(() => useUIStore.getState().expireTradeToast(id), 5000);
    return false;
  }
  return sendPlaceBounty({ targetPlayerId, amount });
}

export const BountyAction = memo(function BountyAction({ targetPlayerId }: { targetPlayerId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={ROW_SX} data-testid="bounty-action">
      <Tooltip title="Put a bounty on this pilot">
        <IconButton data-testid="ship-action-bounty" size="small" sx={BTN_SX} onClick={() => setOpen((v) => !v)}>
          <GpsFixedIcon sx={ICON_SX} />
        </IconButton>
      </Tooltip>
      {open && BOUNTY_PRESETS.map((amount) => (
        <Box
          key={amount}
          sx={CHIP_SX}
          data-testid="bounty-preset"
          data-amount={amount}
          title={`Costs ${pvpBountyCost(amount)}¢ (includes the burned fee)`}
          onClick={() => {
            if (placeBountyFromHere(targetPlayerId, amount)) setOpen(false);
          }}
        >
          {amount}¢
        </Box>
      ))}
    </Box>
  );
});
