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
    return (
      <Box
        data-testid={`ship-roster-card-${ship.shipId}`}
        data-active={ship.isActive ? '1' : '0'}
        onClick={onClick}
        sx={{
          flexShrink: 0,
          width: 110,
          height: '100%',
          maxHeight: 130,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'space-between',
          py: 0.75,
          px: 1,
          border: '1px solid',
          borderColor: ship.isActive ? '#1f7a4d' : '#2a2f40',
          borderRadius: 1,
          bgcolor: ship.isActive ? 'rgba(0,255,136,0.05)' : 'transparent',
          cursor: 'pointer',
          '&:hover': { borderColor: '#1f7a4d' },
        }}
      >
        <ShipSilhouette shape={kind.shape} size={40} />
        <Typography variant="caption" noWrap sx={{ color: '#cde', maxWidth: '100%', fontSize: 10 }}>
          {kind.displayName}
        </Typography>
        <HealthBar pct={healthPct} compact />
      </Box>
    );
  }

  return (
    <Box
      data-testid={`ship-roster-card-${ship.shipId}`}
      data-active={ship.isActive ? '1' : '0'}
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        p: 1,
        border: '1px solid',
        borderColor: ship.isActive ? '#1f7a4d' : '#2a2f40',
        borderRadius: 1,
        bgcolor: ship.isActive ? 'rgba(0,255,136,0.04)' : 'transparent',
        cursor: 'pointer',
        '&:hover': { borderColor: '#1f7a4d', bgcolor: 'rgba(0,255,136,0.06)' },
      }}
    >
      <Box sx={{ flexShrink: 0, width: 48, display: 'flex', justifyContent: 'center' }}>
        <ShipSilhouette shape={kind.shape} size={40} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.25 }}>
          <Typography variant="body2" sx={{ color: '#cde', fontWeight: 600 }} noWrap>
            {kind.displayName}
          </Typography>
          {ship.isActive && (
            <Chip
              label="ACTIVE"
              size="small"
              sx={{
                height: 16,
                bgcolor: 'rgba(0,255,136,0.15)',
                color: '#00ff88',
                '& .MuiChip-label': { px: 0.75, fontSize: 9, letterSpacing: 0.5 },
              }}
            />
          )}
        </Box>
        <HealthBar pct={healthPct} numeric={`${Math.round(ship.health)} / ${Math.round(kind.maxHealth)}`} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5, fontSize: 10, color: '#888' }}>
          <span data-testid={`ship-roster-sector-${ship.shipId}`}>{ship.sectorKey}</span>
          <span>·</span>
          <span data-testid={`ship-roster-grid-${ship.shipId}`}>Grid {gx}, {gy}</span>
        </Box>
      </Box>
    </Box>
  );
}

function HealthBar({ pct, numeric, compact }: { pct: number; numeric?: string; compact?: boolean }): JSX.Element {
  const color = pct > 60 ? '#00ff88' : pct > 25 ? '#ffaa44' : '#ff5566';
  return (
    <Box sx={{ width: '100%' }}>
      <Box
        sx={{
          width: '100%',
          height: compact ? 3 : 5,
          bgcolor: 'rgba(255,255,255,0.08)',
          borderRadius: 0.5,
          overflow: 'hidden',
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
      {!compact && numeric !== undefined && (
        <Typography variant="caption" sx={{ color: '#888', fontSize: 9.5, mt: 0.25, display: 'block' }}>
          {numeric}
        </Typography>
      )}
    </Box>
  );
}
