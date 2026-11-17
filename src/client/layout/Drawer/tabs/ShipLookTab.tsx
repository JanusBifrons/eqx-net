/**
 * Galaxy map 0c — the Ship look drawer tab: pick the colour and sigil every
 * ship you own wears (`FactionLookPicker`).
 *
 * The players this client knows come from the same `GET /trade/factions`
 * reply the Factions tab reads (their default looks count as taken), polled
 * only while this tab is on screen (drawer-perf rule); a claim refetches.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { useUIStore } from '../../../state/store';
import { loadStoredPlayerId } from '../../../identity/token';
import { fetchFactions } from '../../../net/tradeApi';
import type { PlayerFactionsView } from '../../../../shared-types/factions';
import { DETAIL_SX, TITLE_SX } from './factionsTabStyles';
import { FactionLookPicker } from './FactionLookPicker';

const POLL_MS = 4000;

export const ShipLookTab = memo(function ShipLookTab(): JSX.Element {
  const visible = useUIStore((s) => s.drawerTab === 'look' && s.isDrawerOpen);
  const [view, setView] = useState<PlayerFactionsView | null>(null);
  const playerId = loadStoredPlayerId();

  const load = useCallback(async (): Promise<void> => {
    if (!playerId) return;
    const v = await fetchFactions(playerId);
    if (v !== null) setView(v);
  }, [playerId]);

  useEffect(() => {
    if (!visible) return undefined;
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [visible, load]);

  const reload = useCallback(() => void load(), [load]);
  // The players this client knows (their default looks count as taken).
  const knownPlayerIds = useMemo(() => (view?.rows ?? []).filter((r) => r.kind === 'player').map((r) => r.factionId), [view]);

  return (
    <Box sx={{ p: 1 }} data-testid="ship-look-tab">
      <Typography sx={TITLE_SX}>Your ship look</Typography>
      {!playerId && <Typography sx={DETAIL_SX}>Sign in to choose your ship look.</Typography>}
      {visible && playerId && <FactionLookPicker playerId={playerId} knownPlayerIds={knownPlayerIds} onClaimed={reload} />}
    </Box>
  );
});
