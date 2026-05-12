import { Box, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { ShipRosterCard, type RosterShipEntry } from './ShipRosterCard';
import { ShipDetailModal } from './ShipDetailModal';
import { ROSTER_CAP } from './rosterConstants';

/**
 * Galaxy-map ship roster panel. Fetches the player's roster from
 * `/dev/player-ships?playerId=...` and renders one card per ship. Each
 * card opens `ShipDetailModal` on click with Spawn + Abandon actions.
 *
 * Responsive variants are driven by the `compact` prop — the parent
 * (`GalaxyOverviewScreen`) decides axis + sizing based on `useIsCompact`,
 * the panel just renders. Landscape/desktop hosts pass `compact={false}`
 * (full cards in a vertical column); portrait phone passes
 * `compact={true}` (small icon+name+health-bar cards in a horizontal
 * scrolling row).
 *
 * Spawn dispatch: the modal calls `onSpawn(shipId)` which the parent
 * routes to `joinOrCreate('sector', { shipId, ... })` with the ship's
 * stored sector key. Abandon dispatch hits the server's
 * `POST /dev/player-ships/:shipId/abandon` and refreshes the list.
 *
 * Phase 3: panel polls every 3s. Phase 5 will switch to server-push via
 * the `SHIP_ROSTER` message.
 */
interface ShipRosterPanelProps {
  /** The player's id, looked up by the parent from localStorage. Empty
   *  string disables the panel (no fetch). */
  playerId: string;
  /** When true, render the compact (portrait-phone) layout: small cards,
   *  horizontal scroll, minimal info. When false, render the full
   *  landscape/desktop layout: large cards, vertical scroll, full info. */
  compact?: boolean;
  /** Invoked when the user picks Spawn on a card. Parent routes to the
   *  sector room with `{ shipId, ... }` joinOptions. */
  onSpawn: (shipId: string, sectorKey: string) => void;
}

const POLL_MS = 3000;
const ENDPOINT_LIST = '/dev/player-ships';
const ENDPOINT_ABANDON = (shipId: string): string => `/dev/player-ships/${encodeURIComponent(shipId)}/abandon`;

export function ShipRosterPanel({ playerId, compact = false, onSpawn }: ShipRosterPanelProps): JSX.Element | null {
  const [ships, setShips] = useState<RosterShipEntry[]>([]);
  const [openShipId, setOpenShipId] = useState<string | null>(null);

  const [debugStatus, setDebugStatus] = useState<string>('init');
  const refresh = useCallback(async (): Promise<void> => {
    if (playerId === '') { setDebugStatus('no-pid'); return; }
    try {
      const url = `${ENDPOINT_LIST}?playerId=${encodeURIComponent(playerId)}`;
      const res = await fetch(url);
      if (!res.ok) { setDebugStatus(`http-${res.status}`); return; }
      const body = (await res.json()) as { ships?: RosterShipEntry[] };
      const out = Array.isArray(body.ships) ? body.ships : [];
      setShips(out);
      setDebugStatus(`ok n=${out.length}`);
    } catch (err) {
      setDebugStatus(`err: ${(err as Error).message ?? 'unknown'}`);
    }
  }, [playerId]);

  useEffect(() => {
    if (playerId === '') return;
    void refresh();
    const handle = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(handle);
  }, [playerId, refresh]);

  const handleAbandon = useCallback(async (shipId: string): Promise<void> => {
    try {
      await fetch(ENDPOINT_ABANDON(shipId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
      setOpenShipId(null);
      await refresh();
    } catch {
      // Best-effort; user can retry.
    }
  }, [playerId, refresh]);

  const handleSpawn = useCallback((shipId: string, sectorKey: string): void => {
    setOpenShipId(null);
    onSpawn(shipId, sectorKey);
  }, [onSpawn]);

  // Render the shell even when there's no playerId — the debug line will
  // surface "no-pid" so we can tell from the rendered UI whether the
  // panel mounted at all.
  const openShip = openShipId !== null ? ships.find((s) => s.shipId === openShipId) ?? null : null;

  return (
    <Box
      data-testid="ship-roster-panel"
      data-roster-count={ships.length}
      sx={{
        display: 'flex',
        flexDirection: compact ? 'row' : 'column',
        gap: 0.5,
        p: 0.5,
        overflowX: compact ? 'auto' : 'hidden',
        overflowY: compact ? 'hidden' : 'auto',
        bgcolor: 'rgba(8, 12, 24, 0.55)',
        backdropFilter: 'blur(2px)',
        border: '1px solid rgba(31, 36, 64, 0.7)',
        borderRadius: 1,
        width: '100%',
        height: '100%',
        pointerEvents: 'auto',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 0.5,
          px: 0.25,
          flexShrink: 0,
          ...(compact ? { writingMode: 'horizontal-tb' } : {}),
        }}
      >
        <Typography sx={{ color: '#00ff88', letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 8 }}>
          Ships
        </Typography>
        <Typography sx={{ color: '#888', fontSize: 8 }}>
          {ships.length}/{ROSTER_CAP}
        </Typography>
      </Box>
      {/* TEMP debug — remove once Phase 3 lands cleanly. Shows fetch state +
       *  the playerId the panel is using so we can see at a glance why the
       *  panel is empty (no pid in localStorage / endpoint 404 / etc.). */}
      <Typography
        data-testid="ship-roster-debug"
        sx={{ color: '#ffaa44', fontSize: 7, lineHeight: 1, px: 0.25, wordBreak: 'break-all' }}
      >
        pid:{playerId === '' ? '∅' : playerId.slice(0, 8)} · {debugStatus}
      </Typography>
      {ships.length === 0 ? (
        <Box sx={{ p: 0.5, color: '#666', fontSize: 9 }}>
          {compact ? 'None yet' : 'None yet — pick a sector to spawn.'}
        </Box>
      ) : (
        ships.map((ship) => (
          <ShipRosterCard
            key={ship.shipId}
            ship={ship}
            compact={compact}
            onClick={() => setOpenShipId(ship.shipId)}
          />
        ))
      )}
      {openShip !== null && (
        <ShipDetailModal
          ship={openShip}
          open={openShipId !== null}
          onClose={() => setOpenShipId(null)}
          onSpawn={(s) => handleSpawn(s.shipId, s.sectorKey)}
          onAbandon={(s) => { void handleAbandon(s.shipId); }}
        />
      )}
    </Box>
  );
}
