import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import { getShipKind } from '../../shared-types/shipKinds';
import { ShipSilhouette } from '../render/shipShapeSvg';
import { GRID_CELL } from './rosterConstants';
import type { RosterShipEntry } from './ShipRosterCard';

/**
 * Detail modal for one roster ship. Full silhouette + full stats + a
 * Spawn primary action and an Abandon destructive action. Abandon
 * always works for the caller's own ships — including active ones —
 * since the server-side endpoint no longer 409's on active state.
 *
 * Phase 4 will replace the simple delete-from-roster Abandon with a
 * "leave a wreck behind" flow (ownerless hull stays in the sector).
 */
interface ShipDetailModalProps {
  ship: RosterShipEntry;
  open: boolean;
  onClose: () => void;
  onSpawn: (ship: RosterShipEntry) => void;
  onAbandon: (ship: RosterShipEntry) => void;
}

export function ShipDetailModal({ ship, open, onClose, onSpawn, onAbandon }: ShipDetailModalProps): JSX.Element {
  const kind = getShipKind(ship.kind);
  const healthPct = Math.max(0, Math.min(100, Math.round((ship.health / kind.maxHealth) * 100)));
  const gx = Math.round(ship.x / GRID_CELL);
  const gy = Math.round(ship.y / GRID_CELL);
  const isActive = ship.isActive && ship.activeRoomId !== null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      data-testid="ship-detail-modal"
      PaperProps={{ sx: { bgcolor: '#0c1020', border: '1px solid #2a2f40' } }}
    >
      <DialogTitle sx={{ bgcolor: '#0c1020', color: '#00ff88', display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <span>{kind.displayName}</span>
        {isActive && (
          <Chip
            label="ACTIVE"
            size="small"
            sx={{
              height: 18,
              bgcolor: 'rgba(0,255,136,0.15)',
              color: '#00ff88',
              '& .MuiChip-label': { px: 0.75, fontSize: 10, letterSpacing: 0.5 },
            }}
          />
        )}
      </DialogTitle>
      <DialogContent sx={{ bgcolor: '#0c1020', color: '#ccc' }}>
        <Box sx={{ display: 'flex', justifyContent: 'center', my: 1 }}>
          <ShipSilhouette shape={kind.shape} size={96} />
        </Box>
        <Typography variant="caption" sx={{ color: '#888', display: 'block', textAlign: 'center', mb: 1.5 }}>
          {kind.description}
        </Typography>
        <Stack direction="row" spacing={1} justifyContent="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
          <StatChip label="Top" value={Math.round(kind.maxSpeed)} />
          <StatChip label="Turn" value={kind.maxAngvel.toFixed(1)} />
          <StatChip label="Hull max" value={Math.round(kind.maxHealth)} />
        </Stack>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1, rowGap: 0.5, mb: 1 }}>
          <StatRow label="Hull" value={`${Math.round(ship.health)} / ${Math.round(kind.maxHealth)} (${healthPct}%)`} />
          <StatRow label="Sector" value={ship.sectorKey} testid="ship-detail-sector" />
          <StatRow label="Grid" value={`${gx}, ${gy}`} testid="ship-detail-grid" />
        </Box>
      </DialogContent>
      <DialogActions sx={{ bgcolor: '#0c1020', justifyContent: 'space-between', px: 2.5, pb: 2 }}>
        <Button
          onClick={() => onAbandon(ship)}
          startIcon={<DeleteForeverIcon />}
          data-testid="ship-detail-abandon"
          sx={{
            color: '#ff5566',
            border: '1px solid #5a2030',
            '&:hover': { bgcolor: 'rgba(255,85,102,0.08)' },
          }}
        >
          Abandon
        </Button>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose} sx={{ color: '#9aa0b4' }} data-testid="ship-detail-close">Close</Button>
          <Button
            onClick={() => onSpawn(ship)}
            startIcon={<RocketLaunchIcon />}
            variant="contained"
            data-testid="ship-detail-spawn"
            sx={{
              bgcolor: '#1f7a4d',
              color: '#fff',
              '&:hover': { bgcolor: '#288c5b' },
            }}
          >
            Spawn
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
}

function StatChip({ label, value }: { label: string; value: number | string }): JSX.Element {
  return (
    <Chip
      size="small"
      label={`${label} ${value}`}
      sx={{
        bgcolor: 'rgba(0,255,136,0.06)',
        color: '#cde',
        height: 22,
        '& .MuiChip-label': { px: 1, fontSize: 11 },
      }}
    />
  );
}

function StatRow({ label, value, testid }: { label: string; value: string; testid?: string }): JSX.Element {
  return (
    <>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Typography>
      <Typography variant="caption" data-testid={testid} sx={{ color: '#cde' }}>
        {value}
      </Typography>
    </>
  );
}
