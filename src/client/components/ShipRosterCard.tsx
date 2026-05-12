import { Box, Chip, Typography } from '@mui/material';
import { getShipKind } from '../../shared-types/shipKinds';
import { ShipSilhouette } from '../render/shipShapeSvg';
import { GRID_CELL } from './rosterConstants';

/**
 * One roster entry as the server reports it. Mirrors the JSON returned
 * by `/dev/player-ships` (see `devPlayerShipsHandler`). Keep this in
 * sync with the server-side shape — they are wire contracts.
 */
export interface RosterShipEntry {
  shipId: string;
  kind: string;
  kindVersion: number;
  health: number;
  sectorKey: string;
  x: number;
  y: number;
  isActive: boolean;
  activeRoomId: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

interface ShipRosterCardProps {
  ship: RosterShipEntry;
  compact: boolean;
  onClick: () => void;
}

/**
 * One row in the ship-roster panel. Two variants:
 *   - Full (landscape/desktop): ship silhouette + name + kind, health
 *     bar with numeric, sector chip + grid `(gx, gy)`, ACTIVE pill if
 *     currently bound to a room.
 *   - Compact (portrait phone): icon + name + slim health bar only,
 *     fixed width so several cards lay out in a horizontal scroll.
 *
 * Click on either variant opens the detail modal.
 */
export function ShipRosterCard({ ship, compact, onClick }: ShipRosterCardProps): JSX.Element {
  const kind = getShipKind(ship.kind);
  const healthPct = Math.max(0, Math.min(100, Math.round((ship.health / kind.maxHealth) * 100)));
  const gx = Math.round(ship.x / GRID_CELL);
  const gy = Math.round(ship.y / GRID_CELL);

  if (compact) {
    // Tiny portrait-phone card: 52 px square, icon + slim health bar.
    return (
      <Box
        data-testid={`ship-roster-card-${ship.shipId}`}
        data-active={ship.isActive ? '1' : '0'}
        onClick={onClick}
        sx={{
          flexShrink: 0,
          width: 52,
          height: 52,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.25,
          py: 0.25,
          border: '1px solid',
          borderColor: ship.isActive ? '#1f7a4d' : 'rgba(42, 47, 64, 0.6)',
          borderRadius: 0.75,
          bgcolor: ship.isActive ? 'rgba(0,255,136,0.06)' : 'transparent',
          cursor: 'pointer',
          '&:hover': { borderColor: '#1f7a4d' },
        }}
      >
        <ShipSilhouette shape={kind.shape} size={28} />
        <HealthBar pct={healthPct} thickness={2} />
      </Box>
    );
  }

  // Landscape/desktop: 36 px tall row — icon + name on top, slim health
  // bar underneath. Sector/grid coords moved to the detail modal to
  // keep the floating overlay tiny.
  return (
    <Box
      data-testid={`ship-roster-card-${ship.shipId}`}
      data-active={ship.isActive ? '1' : '0'}
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 0.5,
        py: 0.25,
        border: '1px solid',
        borderColor: ship.isActive ? '#1f7a4d' : 'rgba(42, 47, 64, 0.6)',
        borderRadius: 0.75,
        bgcolor: ship.isActive ? 'rgba(0,255,136,0.06)' : 'transparent',
        cursor: 'pointer',
        '&:hover': { borderColor: '#1f7a4d', bgcolor: 'rgba(0,255,136,0.04)' },
      }}
    >
      <Box sx={{ flexShrink: 0, display: 'flex' }}>
        <ShipSilhouette shape={kind.shape} size={22} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography sx={{ color: '#cde', fontSize: 10, fontWeight: 600, lineHeight: 1.15 }} noWrap>
            {kind.displayName}
          </Typography>
          {ship.isActive && (
            <Chip
              label="●"
              size="small"
              sx={{
                height: 10,
                bgcolor: 'transparent',
                color: '#00ff88',
                '& .MuiChip-label': { px: 0, fontSize: 8 },
              }}
              data-testid={`ship-roster-active-${ship.shipId}`}
            />
          )}
        </Box>
        <HealthBar pct={healthPct} thickness={2} />
      </Box>
      <Typography sx={{ color: '#666', fontSize: 8, ml: 0.25 }} data-testid={`ship-roster-grid-${ship.shipId}`}>
        {gx},{gy}
      </Typography>
    </Box>
  );
}

function HealthBar({ pct, thickness }: { pct: number; thickness: number }): JSX.Element {
  const color = pct > 60 ? '#00ff88' : pct > 25 ? '#ffaa44' : '#ff5566';
  return (
    <Box
      sx={{
        width: '100%',
        height: thickness,
        bgcolor: 'rgba(255,255,255,0.08)',
        borderRadius: 0.5,
        overflow: 'hidden',
        mt: 0.25,
      }}
    >
      <Box
        data-testid="ship-roster-health-fill"
        sx={{
          width: `${pct}%`,
          height: '100%',
          bgcolor: color,
          transition: 'width 200ms ease, background-color 200ms ease',
        }}
      />
    </Box>
  );
}
