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

  const refresh = useCallback(async (): Promise<void> => {
    if (playerId === '') return;
    try {
      const url = `${ENDPOINT_LIST}?playerId=${encodeURIComponent(playerId)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const body = (await res.json()) as { ships?: RosterShipEntry[] };
      setShips(Array.isArray(body.ships) ? body.ships : []);
    } catch {
      // Network blip or server bouncing. Next poll will retry.
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
      const res = await fetch(ENDPOINT_ABANDON(shipId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
      if (!res.ok && res.status === 409) {
        // Player tried to abandon their active ship. Surface a soft
        // warning; the modal stays open so the user sees their click
        // didn't take effect.
        // Phase 4 will allow active-ship abandon (becomes a wreck).
        // For now leave a console hint; UI affordance is the modal's
        // disabled-while-active state added below.
        console.warn('Cannot abandon your active ship — disconnect first.');
        return;
      }
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

  if (playerId === '') return null;

  const openShip = openShipId !== null ? ships.find((s) => s.shipId === openShipId) ?? null : null;

  return (
    <Box
      data-testid="ship-roster-panel"
      data-roster-count={ships.length}
      sx={{
        display: 'flex',
        flexDirection: compact ? 'row' : 'column',
        gap: 1,
        p: 1,
        overflowX: compact ? 'auto' : 'hidden',
        overflowY: compact ? 'hidden' : 'auto',
        bgcolor: 'rgba(8, 12, 24, 0.85)',
        border: '1px solid #1f2440',
        borderRadius: 1,
        ...(compact
          ? { width: '100%', height: '100%' }
          : { width: '100%', height: '100%', minWidth: 240 }),
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 1,
          px: 0.5,
          minHeight: 22,
          flexShrink: 0,
        }}
      >
        <Typography variant="caption" sx={{ color: '#00ff88', letterSpacing: 1, textTransform: 'uppercase' }}>
          Your ships
        </Typography>
        <Typography variant="caption" sx={{ color: '#888' }}>
          {ships.length}/{ROSTER_CAP}
        </Typography>
      </Box>
      {ships.length === 0 ? (
        <Box sx={{ p: compact ? 1 : 2, color: '#666', fontSize: 11 }}>
          {compact ? 'No ships yet.' : 'No ships in your roster yet. Pick a sector on the map to spawn your first.'}
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
